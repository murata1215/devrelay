# 公開型 Team: 純粋な購読者の ask が常に候補なしになるバグの根治

## きっかけ

body 無し POST バグ（`request-headers-rules.ts`）の修正後、yahoo が公開型チーム
（`pixterm`）を購読できた。続けて yahoo のチャットで `ask pixterm-server:` を実行すると:

```
❌ "pixterm-server" は宛先として登録されていません。
送信できる宛先:
 • agent / pixblog-flutter / MyApplication / mimamori-flutter  （すべて yahoo 自身のもの）
```

公開型で購読したはずの `pixterm-server` / `term-flutter` が 1 件も候補に出なかった。

## 調査

DB は正しい状態だった（`TeamSubscription` 1 行・`Team.visibility='organization'`）。
SQL で `listCrossTeamAskCandidateProjects()` の購読経路を手動再現すると、2 件とも
正しく候補として出てきた。つまり**ロジック自体は正しいが、コードに到達していない**
ことを意味した。

### 真因

`apps/server/src/services/cross-team-authz.ts` の `listCrossTeamAskCandidateProjects()`
（チャット経路）を読むと、招待型 grant を取得した直後に無条件の早期 return があった:

```ts
const grants = await prisma.crossTeamGrant.findMany({
  where: { askAllowed: true, revokedAt: null, requesterUserId: callerUserId },
  ...
});
if (grants.length === 0) return [];        // ★ ここで即 return
...
// （ずっと下、Phase A で追加したコード）
const subscriptionCandidates = await loadSubscriptionAskCandidateEntries(...);  // ← 到達しない
```

**Phase A で購読候補を合流させるコードを、既存の早期 return より後ろに足してしまって
いた。** この早期 return は招待型だけの世界では正しかった（grant が 0 件＝宛先なし）が、
公開型では「招待の grant が 0 件でも購読があれば宛先がある」ため前提が崩れていた。

DB で裏が取れた:

| | requester 側の有効な ask grant |
|---|---|
| yahoo（純粋な購読者） | **0 件** → 早期 return で即終了 |
| gmail（招待型の Team オーナー） | 4 件 → 早期 return されない |

**純粋な購読者＝公開型の主役のケースだけが壊れていた**ため、実装者（gmail）が自分の
経路で試すと再現しないバグだった。Agent REST 経路（`loadCrossTeamCandidates()`）は
`Promise.all([loadInviteGrantCandidates, loadSubscriptionCandidates])` で招待・購読を
独立に集めていたため、同種の問題は発生していなかった（修正不要）。

## 実装内容

早期 return を公開型キルスイッチとの AND にした:

```ts
const publishEnabled = isCrossTeamPublishEnabled(process.env.DEVRELAY_CROSS_TEAM_PUBLISH);
...
if (grants.length === 0 && !publishEnabled) return [];
```

公開型 OFF 時は従来どおり無条件の早期 return が効き、追加クエリも発生しない
（挙動・クエリ数とも完全に不変）。併せて `grants` が空配列のときに無意味な
`organizationMember.findMany({ where: { userId: { in: [] } } })` を投げないよう
`granteeUserIds.length > 0` でガードした。

購読由来の候補は `granteeUserId = team.userId` で、`selectPublishableMembers()` が
`machine.userId === team.userId` を保証済みなので、後続の所有者スナップショット照合
（`grantByProjectId` 由来のロジック）もそのまま通る。

## 回帰テスト

この種の「既存の早期 return の後ろに新経路を足して到達不能」は純関数テストでは
捕まらないため、`cross-team-api-wiring.test.mjs` にソース静的ガードを 4 件追加した:

- 早期 return が `grants.length === 0 && !publishEnabled` の AND になっていること
- 無条件の `if (grants.length === 0) return [];` が復活していないこと
- `loadSubscriptionAskCandidateEntries(` の呼び出しが関数内に残っていること
- `loadCrossTeamCandidates`（Agent REST 経路）が `Promise.all` で招待・購読を
  独立に集めている構造が保たれていること（同種のバグが Agent REST 経路にも
  紛れ込んでいないかの固定）

## 検証

`pnpm build` 全 6 workspace green。`apps/server` の `node --test` 1499/1499
（新規 4 ケース含む非退行）。

## 変更ファイル

既存 `apps/server/src/services/cross-team-authz.ts`、
`apps/server/tests/cross-team-api-wiring.test.mjs`。**WebUI の変更なし。
`cross-team-guard.ts`（認可の純関数）・`cross-team-publish.ts`・新設 6 ルートは
一切変更していない。** DB スキーマ変更なし・新規キルスイッチなし。ソースコード
変更ありのため `pnpm build` 実行済み、再起動が必要。

## 教訓

既存の早期 return の後ろに新しい経路を足すと、その早期 return の前提が新機能で
崩れていた場合に静かに到達不能になる。今回は「grant 0 件＝宛先なし」という招待型の
前提が、公開型（購読だけで宛先になり得る）で成り立たなくなっていた。

新しい認可経路を既存関数に追加するときは、**その関数内の全ての早期 return の前提が
新経路でも成り立つか**を個別に確認する必要がある。Agent REST 経路（`loadCrossTeamCandidates`）
は偶然にも「招待と購読を最初から並列・独立に集める」設計だったため同じ罠を踏まなかった
が、これは設計判断の結果というより結果論に近い。今後同種の機能を追加する際は、
「独立した経路を Promise.all で集めて結合する」形を標準パターンとして意識する。
