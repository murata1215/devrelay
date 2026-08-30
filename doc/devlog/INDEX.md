# Devlog INDEX

- 2026-08-23_062023 | agent専用Message読み取りREST追加(#324) | 他プロジェクトの直近Messageを読むGET /api/agent/messagesを既存資産再利用で追加、実地検証済み
- 2026-08-29_130620 | MCP note?/council?受け口追加(#331) | approve_implementationのnote実効化とsubmit_instructionのcouncil受理・永続化、councilエンジン自体は未実装で別サイクル
- 2026-08-29_201458 | MCP plan skipPermissions強制ON解消(#332) | forceNewSessionと権限ポリシーを分離、permissionPolicyでMCP planをstrictReadonly化、exec/チャットは従来どおり
- 2026-08-30_064135 | strictReadonlyグロブfalse positive修正(#333) | セグメント分割+argv0判定に変更、allowedTools∪DEFAULT_ALLOWED_TOOLSの和集合でallow判定、deny reasonを3分類+detail化
- 2026-08-30_092942 | 人間入力テキストの長さ上限・provenance fence・監査(#334) | ゲート①②③（note/e,指示/instruction）に長さ検証（副作用より前）+fenceHumanText+Message.humanTextMeta監査を追加、promptOriginでw判定を構造化、Agent無変更
- 2026-08-30_104506 | #334 follow-up: 検証で見つかった軽微3点の修正 | ②のhumanTextMetaにneutralized追加（①③とキー一致）、changelog残件に上限値未調整を追記、テスト件数17→16件に訂正（前サイクルdevlogの誤記は改変せず本ファイルに記録）
- 2026-08-30_203205 | ゲート⑤(ask)/⑥(teamexec)人間入力テキスト検証+F3解消(#335) | fenceIfHuman/buildHumanTextMetaを既存human-text-fence.tsに追加、⑤⑥に長さ検証(4000)+fence+humanTextMeta監査、F3転送のorigin伝播で二重fence不成立を構造的に保証、Agent無変更・DDL不要
