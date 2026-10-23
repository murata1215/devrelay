# FCM プッシュ通知の無音故障 — 原因調査と再発防止（2026-10-23）

## 発端

ユーザー報告: 「Flutter アプリ入れ直し？もしくは DevRelay のメンテ後？から iPhone に通知が来なくなった」

## 原因（確定）

**DevRelay サーバーのメンテ（commit `d3f3979`、Notification.sessionId 追加等）は無関係。**
2026-10-22 17:46 の `flutter install --release` による実機への再インストールが起点。

### タイムライン（JST）

| 時刻 | 出来事 |
|---|---|
| 10/16〜10/22 02:35 | アプリが FCM トークンを計6回登録（全200）。毎回 `total: 3` = 同一トークンの上書き |
| 10/22 05:48:46 | FCM が `registration-token-not-registered` を返し、サーバーが生きていたトークンを削除（3→2件） |
| 10/22 07:03 / 08:59 / 18:54 | サーバー再起動。3回とも FCM 初期化成功（FCM 自体は正常） |
| **10/22 17:46:12** | **`flutter install --release` で実機に再インストール** |
| 10/22 17:58:20 | アプリが `/api/notifications` に 200 でアクセス（ログイン状態は維持） |
| 10/22 05:48 以降〜23日時点 | `POST /api/push/fcm/subscribe` が 1 件も来ない |
| 同期間 | AI ターン 110 件以上完了、FCM 送信エラーは 0 件（エラーすら出ない無音故障） |

### メカニズム

1. `flutter install` は旧アプリを削除してから入れるため、iOS の通知許可が `notDetermined` にリセットされる
2. Keychain のログイントークンは削除後も残るため、アプリは「ログイン済みで動作しているが
   通知だけ取れない」状態になる
3. `getToken()` 失敗 → `_fcmToken == null` → 登録 POST が発生しない。Flutter 側は
   `_fcmTokenRegistered` を実行前に true にしているため再試行もされない
4. サーバーには配信先の無いトークンのみ残る。`messaging.send()` は FCM に受理されるためエラーも
   出ず、ログも DB も変化しないまま無音で壊れ続けた

潜在要因として検討した「`aps-environment=development` 固定（release でも APNs sandbox）」は、
Firebase Console 確認（ユーザー提供情報）で **APNs 認証キー(.p8) が開発用・本番用の両方に
登録済み**であることが分かり、.p8 は sandbox/production 両対応のため却下した。

### サーバー側の構造的欠陥（「無音」の正体）

`apps/server/src/services/fcm-service.ts`（修正前）
- 配信先トークン 0 件・未初期化で**無言 return**。成功時もログ無し
- `invalid-argument` 等の曖昧なエラーでも**即削除**（別 Firebase プロジェクト発行トークンでも
  返るため、環境ズレで正しいトークンまで消える危険があった）
- 呼び出し元 2 箇所（`session-manager.ts`/`agent-manager.ts`）とも fire-and-forget

## 対策（Phase A〜C、本サイクルで実装）

### Phase A（サーバー）
- `services/fcm-token-rules.ts`（新規・外部 import ゼロの純関数）: トークン正規化・エラー分類・
  削除判定・健全性判定・マスク処理・ポリシー解決
- `services/fcm-token-store.ts`（新規）: トークン永続化 + userId ごとの直列化（read-modify-write
  の競合を実用上解消）
- `services/fcm-metrics.ts`（新規）: プロセス寿命の送信メトリクス
- `services/fcm-service.ts`: 送信結果を必ず1行ログ化、配信先0件・未初期化を警告ログ化、
  削除ポリシーを安全化（`invalid-argument` は連続5回失敗まで削除しない、全滅ガードで
  「全トークンが同一エラーで失敗」時は削除自体を中止）
- 同梱修正: `agent-manager.ts` の承認通知で `projectName` に実はマシン名が渡っていた表示バグを修正。
  `GET /api/settings` が素の FCM トークン・Web Push 秘密鍵をそのまま返していた漏洩を修正

### Phase B（サーバー、診断 API）
- `GET /api/push/fcm/devices`: 登録済み端末一覧（トークンは先頭マスクのみ）+ 健全性サマリ +
  プロセスメトリクス
- `POST /api/push/fcm/test`: 自分の全端末にテスト通知を送り、端末ごとの成否を返す
  （削除は絶対に行わない）
- `POST /api/push/fcm/verify`: トークン登録状況の自己診断（Phase E で Flutter が使う想定の部品）
- `DELETE /api/push/fcm/devices/:tokenPrefix`: 死んだ端末の手動削除

### Phase C（WebUI）
- 設定画面の Notification セクションに `PushDevicesSection`（端末一覧・ヘルスバッジ・
  テスト通知ボタン）を追加

### Phase D（見送り）・Phase E（別マシンへの依頼）
- Phase D（stale トークンの自動掃除）は本サイクルでは見送り
- Phase E（Flutter 側: subscribe 契機の拡張・起動時自己診断・権限無効時バナー等）は
  `doc/flutter-push-api-contract.md` にまとめ、別途 Mac の `devrelay_flutter` へ依頼する

## キルスイッチ

| 変数 | 既定 | 用途 |
|---|---|---|
| `DEVRELAY_PUSH_DIAG` | `1` | 診断ログ（0件警告・送信結果ログ）を出すか。`0` で従来どおり無言 |
| `DEVRELAY_FCM_STRICT_DELETE` | `0` | `1` で旧挙動（`invalid-argument` 即削除）に戻す |
| `DEVRELAY_FCM_TEST_API` | `1` | `POST /api/push/fcm/test` を有効にするか |

## DB マイグレーション

**なし。** `UserSettings(key='fcm_tokens')` の JSON 配列に optional フィールドを追加しただけ。

## 変更ファイル

- 新規: `apps/server/src/services/{fcm-token-rules,fcm-token-store,fcm-metrics}.ts`
- 新規: `apps/server/tests/fcm-token-rules.test.mjs`
- 新規: `apps/web/src/lib/push-device-rules.ts`、`apps/web/src/components/settings/PushDevicesSection.tsx`
- 新規: `apps/web/tests/push-device-rules.test.mjs`
- 新規: `doc/flutter-push-api-contract.md`
- 変更: `apps/server/src/services/fcm-service.ts`（全面再構成）、
  `apps/server/src/services/agent-manager.ts`（表示バグ修正）、
  `apps/server/src/routes/api.ts`（新規ルート追加、設定レスポンスの秘密除外）、
  `apps/web/src/lib/api.ts`（`pushDevices` API）、`apps/web/src/pages/SettingsPage.tsx`（セクション追加）、
  `apps/web/tsconfig.test.json`（テスト対象追加）、`CLAUDE.md`（env 表追記）

## テスト結果

- `apps/server`: 1263/1263 green（新規 47 件。全滅ガード・strictDelete・allowRemoval・旧スキーマ
  正規化・registeredAt 保持の回帰テスト含む）
- `apps/web`: 873/873 green（新規 19 件）
- `pnpm --filter @devrelay/server build` / `pnpm --filter web build` ともに成功

## 残課題

- 本番 DB の `UserSettings(key='fcm_tokens')` の直接確認はハーネスの権限分類でブロックされたまま
  （`GET /api/push/fcm/devices` が入ったことで同等の情報が WebUI から安全に見られるようになったため、
  実務上の支障はない）
- Phase E（Flutter 側対応）は未着手。`doc/flutter-push-api-contract.md` を添えて別途依頼が必要
