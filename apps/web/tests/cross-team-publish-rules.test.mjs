// 公開型 Team（apps/web/src/lib/cross-team-publish-rules.ts）確認文言・表示状態の単体テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist-test から直接 import する（cross-team-invite-rules.test.mjs と同じ流儀）。
//
// 2026-11-08: 前サイクル（招待型の「公開を停止」確認文言）で、他チーム経由の grant が
// 生きているのに断言してしまう不正確な文言を出した事故があった。公開型でも同種の事故
// （又貸し防止の実態と UI の説明がズレる）を避けるため、文言生成ロジックをテストで固定する。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPublishConfirmMessage,
  buildUnpublishConfirmMessage,
  buildUnsubscribeConfirmMessage,
  buildRemoveSubscriberConfirmMessage,
  describePublishState,
} from '../dist-test/lib/cross-team-publish-rules.js';

describe('buildPublishConfirmMessage', () => {
  test('又貸しで除外される件数が無い（borrowedCount: 0）ときは除外の注記を出さない', () => {
    const msg = buildPublishConfirmMessage({ teamName: 'mimamori', publishableCount: 3, borrowedCount: 0 });
    assert.match(msg, /公開されるプロジェクト: 3 件/);
    assert.doesNotMatch(msg, /借りている/);
  });

  test('又貸しで除外される件数がある（本サイクルの UX の肝）ときは件数つきで注記する', () => {
    const msg = buildPublishConfirmMessage({ teamName: 'pixterm', publishableCount: 2, borrowedCount: 3 });
    assert.match(msg, /公開されるプロジェクト: 2 件/);
    assert.match(msg, /他ユーザーから借りている 3 件は公開されません（又貸しになるため）/);
  });

  test('チーム名が本文に含まれる', () => {
    const msg = buildPublishConfirmMessage({ teamName: 'テストチーム', publishableCount: 1, borrowedCount: 0 });
    assert.match(msg, /テストチーム/);
  });

  test('契約消費の注記が常に含まれる', () => {
    const msg = buildPublishConfirmMessage({ teamName: 'x', publishableCount: 1, borrowedCount: 0 });
    assert.match(msg, /あなたの契約で AI が実行されます/);
  });
});

describe('buildUnpublishConfirmMessage', () => {
  test('購読者が 0 人のときは「購読者はいません」の文言になる', () => {
    const msg = buildUnpublishConfirmMessage({ teamName: 'mimamori', subscriberCount: 0 });
    assert.match(msg, /まだ購読者はいません/);
    assert.doesNotMatch(msg, /全員が ask できなくなります/);
  });

  test('購読者がいるときは人数と影響範囲を明示する', () => {
    const msg = buildUnpublishConfirmMessage({ teamName: 'pixterm', subscriberCount: 2 });
    assert.match(msg, /現在 2 名が購読しています/);
    assert.match(msg, /全員が ask できなくなります/);
  });
});

describe('buildUnsubscribeConfirmMessage', () => {
  test('チーム名と公開者名が本文に含まれる', () => {
    const msg = buildUnsubscribeConfirmMessage({ teamName: 'pixterm', publisherName: 'KEISUKE MURATA' });
    assert.match(msg, /pixterm/);
    assert.match(msg, /KEISUKE MURATA さんが公開/);
    assert.match(msg, /ask できなくなります/);
  });
});

describe('buildRemoveSubscriberConfirmMessage', () => {
  test('購読者名とチーム名が本文に含まれる', () => {
    const msg = buildRemoveSubscriberConfirmMessage({ teamName: 'pixterm', subscriberName: 'yahoo user' });
    assert.match(msg, /yahoo user さんの「pixterm」への購読を取り消しますか/);
    assert.match(msg, /ask できなくなります/);
  });
});

describe('describePublishState', () => {
  test('visibility が未定義（公開キルスイッチ OFF）でも例外を投げず非公開として扱う', () => {
    const r = describePublishState({});
    assert.equal(r.published, false);
    assert.equal(r.label, '🔒 非公開');
  });

  test("visibility が 'private' なら非公開", () => {
    const r = describePublishState({ visibility: 'private', subscriberCount: 5 });
    assert.equal(r.published, false);
    assert.equal(r.label, '🔒 非公開');
  });

  test("visibility が 'organization' なら公開中・購読者数つきのラベルになる", () => {
    const r = describePublishState({ visibility: 'organization', subscriberCount: 3 });
    assert.equal(r.published, true);
    assert.equal(r.label, '🌐 公開中 (3)');
  });

  test("visibility が 'organization' でも subscriberCount が未定義なら 0 件扱い", () => {
    const r = describePublishState({ visibility: 'organization' });
    assert.equal(r.published, true);
    assert.equal(r.label, '🌐 公開中 (0)');
  });

  test('未知の visibility 値は非公開として扱う（安全側）', () => {
    const r = describePublishState({ visibility: 'public' });
    assert.equal(r.published, false);
  });
});
