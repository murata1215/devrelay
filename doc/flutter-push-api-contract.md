# Flutter 向け FCM プッシュ通知 API 契約（2026-10-23 無音故障の再発防止）

2026-10-22、iPhone アプリの再インストール後にプッシュ通知が完全に無音で止まる事故が発生した。
本書はサーバー側で完了した対策（Phase A〜C）の契約と、**Flutter 側で対応してほしい内容（Phase E）**
をまとめたもの。サーバー側の変更は Flutter が未対応でも後方互換（既存 `subscribe`/`unsubscribe` の
挙動・レスポンス形式は変わらない）。

対象コミット時点: 2026-10-23（サーバー側 Phase A〜C 適用後）

---

## 1. 何が起きたか（背景）

1. `flutter install --release` による実機への再インストールで、旧アプリが削除され
   **iOS の通知許可が `notDetermined` にリセット**された
2. `flutter_secure_storage`（Keychain）のログイントークンは削除後も残るため、
   アプリは「ログイン済みで動いているが FCM トークンだけ取得できない」状態になった
3. `getToken()` が失敗 → `_fcmToken == null` → **`POST /api/push/fcm/subscribe` が一度も呼ばれない**
4. サーバーには配信先の無い古いトークンだけが残った。FCM はこのトークンへの送信を**エラーなく
   受理してしまう**ため、サーバー側のログにも DB にも異常が残らず、**約1日・100件超の通知が
   無音のまま届かなくなった**

サーバー側は「配信が壊れていることをログと WebUI で見えるようにする」対策（Phase A〜C）を
完了した。ただし **根治（アプリが確実に再登録する）には Flutter 側の対応が必要**（Phase E）。

---

## 2. REST エンドポイント一覧（プッシュ通知関連、全て `Authorization: Bearer <token>` 必須）

| # | Method | Path | 状態 |
|---|---|---|---|
| 1 | POST | `/api/push/fcm/subscribe` | 既存（変更なし） |
| 2 | POST | `/api/push/fcm/unsubscribe` | 既存（変更なし） |
| 3 | GET | `/api/push/fcm/devices` | **新規**（Phase B。WebUI の端末一覧が使う。Flutter からの利用は必須ではない） |
| 4 | POST | `/api/push/fcm/test` | **新規**（Phase B。WebUI の「テスト通知を送る」が使う） |
| 5 | POST | `/api/push/fcm/verify` | **新規**（Phase B。Flutter の自己診断用に用意した部品。§4 参照） |
| 6 | DELETE | `/api/push/fcm/devices/:tokenPrefix` | **新規**（Phase B。WebUI の端末削除ボタンが使う） |

### 2.1 `POST /api/push/fcm/subscribe`（既存・契約に変更なし）

```json
// Request body
{ "fcmToken": "string", "platform": "ios" | "android" }
```
```json
// Response 200
{ "success": true }
```

- 同一トークンの再送信は許容される（冪等）。サーバー内部では「初回登録時刻」と
  「最後に subscribe された時刻」を別々に記録するよう変更したが、**レスポンス形式・ステータスコードは
  変わらない**
- 400: `fcmToken` または `platform` が欠落

### 2.2 `POST /api/push/fcm/verify`（新規・Phase E で使ってほしい部品）

```json
// Request body
{ "fcmToken": "string" }
```
```json
// Response 200
{ "registered": true }
```

- 自分の現トークンがサーバーに登録済みかどうかだけを返す（それ以上の情報は返らない）
- **想定用途**: アプリ起動時に `getToken()` した値をこのエンドポイントに渡し、
  `registered: false` が返ってきたら即座に `subscribe` を呼ぶ（§4.2 参照）

---

## 3. 根本原因と Flutter 側の対応依頼（優先度順）

### 3.1 【最優先・根治】subscribe を呼ぶ契機を増やし、失敗時に再試行する

現状（調査で判明した実装）は `_fcmTokenRegistered` という非永続フラグを、**POST の実行前に**
true にしている。これにより、その起動で `subscribe` が失敗（オフライン・サーバーエラー等）しても
二度と再試行されない。

**依頼**:
- `_fcmTokenRegistered` は **POST が 200 を返した後にのみ** true にする
- 以下の全タイミングで `subscribe` を呼ぶ（冪等なので毎回呼んでよい）:
  1. アプリ起動ごと（cold start）
  2. ログイン成功直後
  3. `FirebaseMessaging.instance.onTokenRefresh` のコールバック内
  4. 通知許可が許可された直後（OS の権限ダイアログ応答後）
- `subscribe` が失敗した場合、指数バックオフ等で再試行する（無限リトライではなく、
  例えば「次回アプリ起動時にもう一度試す」で十分）

### 3.2 【推奨】起動時の自己診断（§2.2 の `verify` を使う）

```
起動時:
  token = await FirebaseMessaging.instance.getToken()
  if (token == null) {
    // 権限が無い・APNs トークン未設定等。§3.3 のバナーを出す
    return
  }
  result = await POST /api/push/fcm/verify { fcmToken: token }
  if (!result.registered) {
    await POST /api/push/fcm/subscribe { fcmToken: token, platform }
  }
```

これにより、**サーバー側がトークンを削除した後でも、次回起動時に自動で復帰する**。
今回の事故のように「サーバーには古いトークンしか残っていない」状態からの回復が
アプリの再インストール無しで可能になる。

### 3.3 【推奨】通知許可が無効なときのバナー導線

`getToken()` が失敗する、または `requestPermission()` が `denied`/`notDetermined` を返した場合、
現状は **ユーザーに見える UI が無い**。アプリ内に「通知が無効になっています」のバナー等を追加し、
OS の設定画面へのディープリンクを用意することを推奨する。

### 3.4 【任意・優先度低】`aps-environment` のビルド構成分け

Firebase Console 確認済み（2026-10-23）: Cloud Messaging は **APNs 認証キー（.p8）方式**で、
開発用・本番環境用の両方に同一キーが登録されている。.p8 は sandbox/production 両対応のため、
**現状の `aps-environment=development` 固定でも配信は成立する**。つまりこれは
**今回の事故の原因ではない**。TestFlight/App Store 配布に向けた整理（release は production に
分ける）としては妥当だが、優先度は低い。

### 3.5 【任意】`installationId` / `deviceLabel` / `appVersion` の送信

`subscribe` の body にこれらを追加で送ってもらえると、サーバー側で同一端末のトークン
ローテーションを正確に扱えるようになる（WebUI の端末一覧の表示も「iPhone SE3 / iOS 18.2」等に
改善できる）。**ただし再インストールでは `installationId` 自体もリセットされるため、
今回の事故そのものの解決にはならない**。対応する場合は以下の形で送ってほしい：

```json
// POST /api/push/fcm/subscribe の body に追加（全て optional、現状の必須フィールドは変わらない）
{
  "fcmToken": "string",
  "platform": "ios",
  "installationId": "string",
  "deviceLabel": "iPhone SE3 / iOS 18.2",
  "appVersion": "1.2.3"
}
```

現在サーバー側はこれらのフィールドを**受け取っても使わない**（後方互換のため、未対応でも
エラーにならない）。将来対応する際はこの契約に従ってほしい。

### 3.6 【確認依頼】通知一覧の未知 `type` 耐性

`GET /api/notifications` が返す `Notification.type` は現状 `'response' | 'approval'`
のみ生成されるが、型としては `'error'` も定義されている（将来「プッシュ通知が壊れています」の
ような通知を出す用途を想定）。**アプリ側が `type` を `switch` で網羅的に扱っている場合、
未知の値でクラッシュまたは非表示にならないかを確認してほしい**。サーバー側が実際に
`'error'` を生成するのはこの確認が取れてから（別サイクル）。

---

## 4. 変更していないもの（安心材料）

- `POST /api/push/fcm/subscribe` / `unsubscribe` の **リクエスト・レスポンス形式は変更なし**
- FCM の `data` マップの内容（`sessionId`/`projectId` 等）は変更なし
- 既存のプッシュ通知の見た目（title/body）は変更なし
- DB スキーマ変更なし（`UserSettings` の JSON に optional フィールドを追加しただけ）

---

## 5. サーバー側の変更点（参考・Flutter の実装には影響しない）

- 配信先 0 件・未初期化での無言 return を廃止し、必ずログに残すようにした
- トークン削除条件を安全化（`invalid-argument` は即削除せず、連続 5 回失敗で削除。
  全トークンが同一エラーで失敗した場合は削除自体を中止する「全滅ガード」を追加）
- `GET /api/settings` から `fcm_tokens` の素の値を除外（専用 API 経由のマスク済み値のみに）
- 詳細は `doc/devlog/2026-10-23_fcm_push_silent_failure.md` 参照
