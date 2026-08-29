# Devlog INDEX

- 2026-08-23_062023 | agent専用Message読み取りREST追加(#324) | 他プロジェクトの直近Messageを読むGET /api/agent/messagesを既存資産再利用で追加、実地検証済み
- 2026-08-29_130620 | MCP note?/council?受け口追加(#331) | approve_implementationのnote実効化とsubmit_instructionのcouncil受理・永続化、councilエンジン自体は未実装で別サイクル
- 2026-08-29_201458 | MCP plan skipPermissions強制ON解消(#332) | forceNewSessionと権限ポリシーを分離、permissionPolicyでMCP planをstrictReadonly化、exec/チャットは従来どおり
- 2026-08-30_064135 | strictReadonlyグロブfalse positive修正(#333) | セグメント分割+argv0判定に変更、allowedTools∪DEFAULT_ALLOWED_TOOLSの和集合でallow判定、deny reasonを3分類+detail化
