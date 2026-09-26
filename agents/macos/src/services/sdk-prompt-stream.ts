/**
 * SDK-prompt-stream: Claude Agent SDK の `query({ prompt })` に渡す入力を「文字列」ではなく
 * 「終了しない AsyncIterable」に差し替えるための、外部 import ゼロの純関数モジュール
 * （sdk-background-tasks.ts / sdk-loop-guard.ts と同じ流儀。linux/macos で byte-for-byte 同一）。
 *
 * ## 背景（2026-09-26 実測、Claude Code 2.1.278 / SDK 0.3.282）
 * DevRelay は `query({ prompt: string, ... })` の形で SDK を呼んでいる。SDK は `prompt` が文字列の
 * 場合 `isSingleUserTurn = true` を立て、**最初の `result` メッセージを受け取った瞬間に CLI への
 * stdin を閉じる**（`transport.endInput()`）。この stdin は、CLI がツール承認（`can_use_tool`）を
 * ホストへ問い合わせるときの唯一の応答経路でもある。
 *
 * ところが `sdk-background-tasks.ts`（2026-09-20 `840d1e4`）導入以降、DevRelay は「途中 result」
 * （バックグラウンド Agent 稼働中の result や `--resume` 直後の空 result）を終端とみなさず、
 * `result` 受信後も for-await を読み続ける。その結果 **stdin が閉じた状態でターンが続行**され、
 * 以降 CLI が承認を要するツール（Write/Edit や許可リスト外の Bash コマンド等）を呼ぶたびに
 * ホストへの問い合わせが送れず `Tool permission request failed: AbortError: Stream closed` になる
 * （承認 UI 側の `canUseTool` コールバックは一度も呼ばれない。読み取り専用ツールは SDK 内の
 * 安全判定で `canUseTool` に到達する前に許可されるため、そこだけ動いて見える）。
 *
 * SDK には「stdin を閉じない」オプションは存在しない。`isSingleUserTurn` は
 * `typeof prompt === "string"` から機械的に決まるため、**`prompt` を `AsyncIterable` に変える**
 * ことが唯一の回避策になる。SDK 実装（`sdk.mjs`）を確認した根拠は以下:
 *
 * - `isSingleUserTurn` が false になれば、`readMessages()` 内の「result を受けたら閉じる」分岐
 *   （`isSingleUserTurn` ガード付き）が発動しなくなる。
 * - 代わりに `Query.streamInput(stream)` が使われる。これは渡された `stream`（本モジュールが
 *   返す AsyncIterable）を `for await` で読み切ってから（＝ストリームが `done: true` を返してから）
 *   初めて `transport.endInput()` を呼ぶ。**単発の使い捨て generator（1 件 yield して即座に
 *   return するだけのもの）では不十分**なことに注意: それだと `streamInput()` の for-await が
 *   即座に完了し、結局ターンの完走前に stdin が閉じてしまう。本モジュールは `release()` が
 *   呼ばれるまで generator の `next()` を pending のまま保持することで、ターンが本当に終わる
 *   （呼び出し元の `finally` に到達する）まで `endInput()` を先送りする。
 *
 * このモジュールが担うのはあくまで「入力ストリームを閉じるタイミングの制御」のみ。
 * `sdk-background-tasks.ts` の延期判定ロジック自体は変更しない（両者は独立して組み合わさる）。
 *
 * 例外を一切投げない（`release()` は複数回呼んでも安全な冪等操作）。
 */

/**
 * SDK に渡す user メッセージの最小形。
 * `@anthropic-ai/claude-agent-sdk` の `SDKUserMessage` 型は import しない
 * （sdk-background-tasks.ts 等と同じ流儀。SDK 側の型変更に振り回されないための最小定義。
 * 実際に SDK の期待する形と一致しているかは tests/sdk-prompt-stream.test.mjs で検証する）。
 *
 * SDK が文字列 prompt を渡されたときに自ら組み立てる JSON
 * （`{type:"user",session_id:"",message:{role:"user",content:[{type:"text",text}]},parent_tool_use_id:null}`）
 * と完全に同形にしている（`verbatimPrompts` は DevRelay 側で未設定＝既定 false のため
 * `client_composed` フィールドは付与しない）。
 */
export interface SdkPromptStreamMessage {
  type: 'user';
  session_id: string;
  message: {
    role: 'user';
    content: Array<{ type: 'text'; text: string }>;
  };
  parent_tool_use_id: null;
}

/** buildSdkPromptStream() の戻り値 */
export interface SdkPromptStreamHandle {
  /**
   * SDK の `query({ prompt: handle.stream, ... })` にそのまま渡す非同期反復可能オブジェクト。
   * 1 件だけプロンプトメッセージを yield した後、`release()` が呼ばれるまで完了しない
   * （＝ SDK 側の `transport.endInput()` を先送りする）。
   */
  stream: AsyncIterable<SdkPromptStreamMessage>;
  /**
   * ターンの完了処理（result ハンドラ・catch・finally のいずれか）が終わった直後に必ず 1 回呼ぶ。
   * 呼ぶまで `stream` は完了しない。冪等（2 回目以降は何もしない）。
   */
  release: () => void;
}

/**
 * `prompt` を 1 件だけ含む「終了しない」AsyncIterable を組み立てる。
 * 呼び出し元は SDK の `for await (const message of query({ prompt: handle.stream, ... }))` が
 * 終わったら（正常終了・catch・abort のいずれでも）必ず `finally` で `handle.release()` を呼ぶこと。
 */
export function buildSdkPromptStream(promptText: string): SdkPromptStreamHandle {
  let releaseResolve: (() => void) | undefined;
  let released = false;
  const releaseSignal = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });

  async function* generate(): AsyncGenerator<SdkPromptStreamMessage> {
    yield {
      type: 'user',
      session_id: '',
      message: {
        role: 'user',
        content: [{ type: 'text', text: promptText }],
      },
      parent_tool_use_id: null,
    };
    // release() が呼ばれるまでここで待機する。SDK の Query.streamInput() は
    // この for-await が完了する（＝このジェネレータが return する）まで
    // transport.endInput()（stdin close）を呼ばない。
    await releaseSignal;
  }

  return {
    stream: generate(),
    release: (): void => {
      if (released) return;
      released = true;
      releaseResolve?.();
    },
  };
}
