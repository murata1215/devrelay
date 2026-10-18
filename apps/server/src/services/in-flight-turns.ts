/**
 * サイクル3.1: 実行中 AI ターン台帳（外部 import ゼロの純粋なデータ構造）。
 *
 * 背景: `isMachineBusy()`（auto-updater.ts）の既存 busy 判定は
 * (a) `progressTrackers`（session-manager.ts）の有無 と (b) 直近 10 分の Message の有無
 * のみで、MCP の exec（approve_implementation → execConversation）・crossquery/teamexec・
 * raw-completion はいずれも tracker を張らないため、これらのターン実行中は busy と判定されず
 * Agent 自己更新が走ってしまっていた（実機で 2 回、実行中ターンが kill された）。
 *
 * この台帳は「サーバーが Agent へ AI プロンプトを送った時点」から「ターン完了・失敗・停止・
 * Agent 切断のいずれかを検知した時点」までを経路を問わず一元的に記録する。
 * I/O を一切持たないため、ユニットテストで全分岐を直接検証できる
 * （auto-update-reconcile.ts / update-busy-rules.ts と同じ流儀）。
 */

export class InFlightTurnRegistry {
  /** machineId -> (key -> 開始時刻ms)。key は sessionId または raw-completion の requestId */
  private readonly byMachine = new Map<string, Map<string, number>>();
  private readonly ttlMs: number;

  constructor(ttlMs = 6 * 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  /** ターン開始を記録する。同一 key の再 start は開始時刻を更新するだけ（上書き、例外は投げない） */
  start(machineId: string, key: string, nowMs: number): void {
    let turns = this.byMachine.get(machineId);
    if (!turns) {
      turns = new Map<string, number>();
      this.byMachine.set(machineId, turns);
    }
    turns.set(key, nowMs);
  }

  /** ターン終了を記録する。@returns 実際に消えた場合 true、元々居なければ false */
  end(machineId: string, key: string): boolean {
    const turns = this.byMachine.get(machineId);
    if (!turns) return false;
    const existed = turns.delete(key);
    if (turns.size === 0) this.byMachine.delete(machineId);
    return existed;
  }

  /** 指定マシンの全エントリを消す（Agent 切断時）。@returns 消した件数 */
  clearMachine(machineId: string): number {
    const turns = this.byMachine.get(machineId);
    if (!turns) return 0;
    const count = turns.size;
    this.byMachine.delete(machineId);
    return count;
  }

  /** TTL 内のエントリが 1 つでもあれば true */
  isBusy(machineId: string, nowMs: number): boolean {
    return this.count(machineId, nowMs) > 0;
  }

  /** TTL 内のエントリ件数（TTL 超過分は数えない。削除はしない＝読み出し専用） */
  count(machineId: string, nowMs: number): number {
    const turns = this.byMachine.get(machineId);
    if (!turns) return 0;
    let n = 0;
    for (const startedAt of turns.values()) {
      if (nowMs - startedAt < this.ttlMs) n++;
    }
    return n;
  }

  /**
   * 指定 key の開始時刻（ms）を返す（会話履歴レールの「実行中」表示用、サイクル: 会話履歴レール）。
   * TTL 判定はここでは行わない（6時間 TTL は自己更新ガード用の安全側の値であり、
   * UI 表示用の「実行中とみなす期間」はこれより短くすべきため、判定は呼び出し側
   * （`thread-activity.ts` の `resolveRunning()`）の責務とする）。
   * @returns 開始時刻（ms）。未登録（machine 自体が無い、または key が無い）なら undefined
   */
  getStartedAt(machineId: string, key: string): number | undefined {
    return this.byMachine.get(machineId)?.get(key);
  }

  /**
   * TTL を超過した全エントリを削除する（取りこぼし経路の保険）。
   * @returns 削除した件数（全マシン合計）
   */
  sweepStale(nowMs: number): number {
    let removed = 0;
    for (const [machineId, turns] of this.byMachine.entries()) {
      for (const [key, startedAt] of turns.entries()) {
        if (nowMs - startedAt >= this.ttlMs) {
          turns.delete(key);
          removed++;
        }
      }
      if (turns.size === 0) this.byMachine.delete(machineId);
    }
    return removed;
  }
}

/**
 * シングルトン。`agent-manager.ts` と `auto-updater.ts` の両方から静的 import できるよう、
 * 台帳自身にインスタンスを置く（agent-manager.ts は auto-updater.ts を動的 import して
 * 循環を避けている既存構造があるため、どちらの静的 import 先にもしない）。
 */
export const inFlightTurns = new InFlightTurnRegistry();
