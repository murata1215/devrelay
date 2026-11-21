/**
 * 公開型 Team（Phase B: WebUI）の確認ダイアログ文言・表示状態を導出する純粋関数（外部 import ゼロ）。
 *
 * 2026-11-08: 前サイクル（招待型の「公開を停止」確認文言）で、他チーム経由の grant が
 * 生きているのに「相手は以後このプロジェクトに ask できなくなります」と断言する不正確な
 * 文言を出してしまった事故があった（`TeamPage.tsx` に直書きしていたため見落とした）。
 * 公開型でも同種の事故（又貸し防止の実態と UI の説明がズレる）を避けるため、確認文言の
 * 生成ロジックをここに集約し、テストで固定する。
 *
 * `buildPublishConfirmMessage()` が本サイクルの UX の肝: サーバー側の又貸し防止
 * （`cross-team-publish.ts` の `selectPublishableMembers()`）が「何を除外したか」を
 * ユーザーに見える形で提示する。借りているプロジェクトが無いチームでは、無関係な
 * 注記を出さない（`borrowedCount === 0` のとき除外の行を省略する）。
 */

export interface BuildPublishConfirmMessageParams {
  teamName: string;
  /** 公開されるプロジェクト数（selectPublishableMembers() で絞り込んだ後の件数） */
  publishableCount: number;
  /** 招待型で借りているため公開対象から除外されるプロジェクト数 */
  borrowedCount: number;
}

/** チームを公開する前の確認ダイアログ文言を組み立てる。 */
export function buildPublishConfirmMessage(params: BuildPublishConfirmMessageParams): string {
  const lines = [
    `チーム「${params.teamName}」を組織に公開しますか？`,
    `公開されるプロジェクト: ${params.publishableCount} 件（あなたが所有するもの）`,
  ];
  if (params.borrowedCount > 0) {
    lines.push(`他ユーザーから借りている ${params.borrowedCount} 件は公開されません（又貸しになるため）`);
  }
  lines.push('同じ組織のメンバーが購読すると、あなたの契約で AI が実行されます。');
  return lines.join('\n');
}

export interface BuildUnpublishConfirmMessageParams {
  teamName: string;
  /** 現在の購読者数（取り消し後は全員が ask できなくなる） */
  subscriberCount: number;
}

/** チームの公開を停止する前の確認ダイアログ文言を組み立てる。 */
export function buildUnpublishConfirmMessage(params: BuildUnpublishConfirmMessageParams): string {
  if (params.subscriberCount === 0) {
    return `チーム「${params.teamName}」の公開を停止しますか？（まだ購読者はいません）`;
  }
  return `チーム「${params.teamName}」の公開を停止しますか？`
    + `\n現在 ${params.subscriberCount} 名が購読しています。停止すると全員が ask できなくなります。`;
}

export interface BuildUnsubscribeConfirmMessageParams {
  teamName: string;
  publisherName: string;
}

/** 自分の購読を解除する前の確認ダイアログ文言を組み立てる。 */
export function buildUnsubscribeConfirmMessage(params: BuildUnsubscribeConfirmMessageParams): string {
  return `チーム「${params.teamName}」（${params.publisherName} さんが公開）の購読を解除しますか？`
    + '\n解除すると、このチームのプロジェクトに ask できなくなります。';
}

export interface BuildRemoveSubscriberConfirmMessageParams {
  teamName: string;
  subscriberName: string;
}

/** Team オーナーが特定の購読者を強制的に取り消す前の確認ダイアログ文言を組み立てる。 */
export function buildRemoveSubscriberConfirmMessage(params: BuildRemoveSubscriberConfirmMessageParams): string {
  return `${params.subscriberName} さんの「${params.teamName}」への購読を取り消しますか？`
    + '\n取り消すと、この方はこのチームのプロジェクトに ask できなくなります。';
}

export interface DescribePublishStateParams {
  /** `GET /api/teams` のレスポンス。公開キルスイッチ OFF 時は undefined（キーごと省略される） */
  visibility?: string;
  subscriberCount?: number;
}

export interface PublishStateLabel {
  /** true = 'organization'（公開中） */
  published: boolean;
  /** ボタンに出す短いラベル（例: "🔒 非公開" / "🌐 公開中 (3)"） */
  label: string;
}

/**
 * チームの公開状態からボタンのラベルを導出する。
 * `visibility` が未定義（公開キルスイッチ OFF、または `GET /api/teams` が未対応の旧レスポンス）
 * でも例外を投げず `published: false` を返す（表示側で安全にフォールバックできるように）。
 */
export function describePublishState(params: DescribePublishStateParams): PublishStateLabel {
  const published = params.visibility === 'organization';
  if (!published) {
    return { published: false, label: '🔒 非公開' };
  }
  const count = params.subscriberCount ?? 0;
  return { published: true, label: `🌐 公開中 (${count})` };
}
