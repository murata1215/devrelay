/**
 * Phaser ゲーム開発スキル（SKILL.md）テンプレート
 *
 * testflight create --phaser で .claude/skills/phaser-gamedev/SKILL.md として配置される。
 * Claude Code がプロジェクト接続時に自動ロードし、ゲーム開発のベストプラクティスを適用する。
 */

export const PHASER_SKILL_MD = `---
name: phaser-gamedev
description: >
  Phaser 3 ゲーム開発スキル。パズルゲーム（マッチ3、落ちもの、スライド、
  数独等）の設計・実装・最適化。モバイルファースト、TypeScript、Vite。
  トリガー: "ゲーム作って", "パズル", "Phaser", "ゲームロジック変更"
---

# Phaser Game Development Skill for DevRelay

パズルゲームを中心とした 2D ブラウザゲーム開発のベストプラクティス集。
Phaser 3 + TypeScript + Vite 環境を前提とする。

---

## 1. 設計原則

### ゲームは動的システムである

ゲームは静的 UI ではない。エンティティが相互作用し、状態が変化し、プレイヤーの入力が全てを駆動する動的システム。

**コードを書く前に必ず設計を考える:**

1. このゲームに必要な **シーン** は何か？（Boot, Menu, Game, Pause, GameOver）
2. どんな **エンティティ** が存在し、どう相互作用するか？
3. シーンを跨いで維持すべき **状態** は何か？
4. どの **物理モデル** が適切か？（パズル系は物理不要が多い）
5. プレイヤーの **入力方法** は？（モバイルタッチ優先）

### 5つのコア原則

1. **Scene-First Architecture** — シーン単位で構造化、グローバル状態を避ける
2. **Composition Over Inheritance** — ゲームオブジェクトとコンポーネントで構築
3. **Constants, Not Magic Numbers** — 全パラメータを定数ファイルに集約
4. **GameState 一元管理** — ゲーム状態を単一オブジェクトで管理
5. **Frame-Rate Independence** — delta time ベース、フレームカウント禁止

---

## 2. プロジェクト構成

### 推奨ディレクトリ構造

\`\`\`
src/
├── main.ts                # Phaser.Game 初期化
├── config/
│   ├── gameConfig.ts      # Phaser 設定
│   └── constants.ts       # ゲームパラメータ定数
├── scenes/
│   ├── BootScene.ts       # アセットロード + プログレスバー
│   ├── MenuScene.ts       # タイトル画面
│   ├── GameScene.ts       # メインゲームプレイ
│   ├── UIScene.ts         # スコア等 HUD オーバーレイ（並列起動）
│   └── GameOverScene.ts   # 結果画面
├── gameObjects/
│   ├── Grid.ts            # パズルグリッド管理
│   ├── Tile.ts            # タイル/ブロック
│   └── Particle.ts        # エフェクト
├── systems/
│   ├── GameState.ts       # 状態管理（スコア、レベル、コンボ）
│   ├── MatchDetector.ts   # マッチ判定ロジック
│   ├── GravitySystem.ts   # 落下処理
│   └── InputManager.ts    # タッチ/キーボード抽象化
└── types/
    └── index.ts           # 型定義
\`\`\`

### Constants パターン（ハードコード禁止）

\`\`\`typescript
// src/config/constants.ts
export const GRID = {
  cols: 6,
  rows: 8,
  tileSize: 64,
  gap: 4,
  offsetX: 48,   // 計算式: (SCREEN.width - (cols * (tileSize + gap) - gap)) / 2
  offsetY: 120,
} as const;

export const SCREEN = {
  width: 480,
  height: 720,
} as const;

export const COLORS = {
  tiles: [0xe74c3c, 0x3498db, 0x2ecc71, 0xf39c12, 0x9b59b6],
  background: 0x1a1a2e,
  text: '#e0e0e0',
  textSub: '#a0a0a0',
} as const;

export const TIMING = {
  matchDelay: 300,      // マッチアニメーション待機 (ms)
  fallDuration: 200,    // 落下アニメーション (ms)
  progressInterval: 8,  // 進捗更新間隔 (秒、DevRelay 用)
} as const;

export const SCORING = {
  basePoints: 10,
  comboMultiplier: 1.5,
} as const;
\`\`\`

### GameState パターン（単一状態管理）

\`\`\`typescript
// src/systems/GameState.ts
export class GameState {
  private _score = 0;
  private _level = 1;
  private _combo = 0;
  private _bestScore = 0;

  get score(): number { return this._score; }
  get level(): number { return this._level; }
  get combo(): number { return this._combo; }

  addScore(points: number): void {
    const multiplied = Math.floor(points * (1 + this._combo * SCORING.comboMultiplier));
    this._score += multiplied;
    if (this._score > this._bestScore) {
      this._bestScore = this._score;
    }
  }

  incrementCombo(): void { this._combo++; }
  resetCombo(): void { this._combo = 0; }

  reset(): void {
    this._score = 0;
    this._level = 1;
    this._combo = 0;
  }
}
\`\`\`

---

## 3. Phaser 基本パターン

### Game Configuration

\`\`\`typescript
const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,           // WebGL → Canvas 自動フォールバック
  parent: 'game-container',
  width: SCREEN.width,
  height: SCREEN.height,
  backgroundColor: COLORS.background,
  scale: {
    mode: Phaser.Scale.FIT,          // 画面にフィット
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [BootScene, MenuScene, GameScene, UIScene, GameOverScene],
};
\`\`\`

### 物理エンジンの選択

| システム | 用途 | パズルでの利用 |
|---------|------|--------------|
| **なし** | メニュー、カードゲーム、マッチ3、数独 | ✅ 大半のパズルはこれ |
| **Arcade** | プラットフォーマー、シューター | 落ちもの系で重力シミュレーション |
| **Matter** | 物理パズル、ラグドール | 特殊な物理パズルのみ |

**パズルゲームの鉄則**: マッチ3・落ちもの・スライド等は**物理エンジン不要**。
論理グリッド（2D配列）でゲーム状態を管理し、Phaser は描画とアニメーションだけ担当。

### シーンライフサイクル

\`\`\`typescript
class GameScene extends Phaser.Scene {
  constructor() {
    super({ key: 'GameScene' });
  }

  init(data: { level?: number }): void {
    // 前のシーンからのデータ受信
    this.level = data.level ?? 1;
  }

  preload(): void {
    // アセットロード（create() の前に完了保証）
  }

  create(): void {
    // ゲームオブジェクト・入力・物理の初期設定
  }

  update(time: number, delta: number): void {
    // ゲームループ（毎フレーム呼ばれる）
    // ✅ delta ベースで計算: this.speed * (delta / 1000)
    // ❌ フレームカウントで計算しない
  }
}
\`\`\`

### シーン遷移

\`\`\`typescript
// 新しいシーンを開始（現在のシーンを停止）
this.scene.start('GameOverScene', { score: this.score });

// 並列起動（UI オーバーレイ等）
this.scene.launch('UIScene');

// 一時停止 / 再開
this.scene.pause('GameScene');
this.scene.resume('GameScene');
\`\`\`

---

## 4. パズルゲーム設計パターン

### 4.1 グリッドベース管理

パズルゲームの核心。論理グリッドと描画を分離する。

\`\`\`typescript
// 論理グリッド（ゲーム状態）
private grid: (TileData | null)[][] = [];

// 初期化
for (let row = 0; row < GRID.rows; row++) {
  this.grid[row] = [];
  for (let col = 0; col < GRID.cols; col++) {
    this.grid[row][col] = {
      colorIndex: Phaser.Math.Between(0, COLORS.tiles.length - 1),
    };
  }
}

// グリッド座標 → ピクセル座標変換
function gridToPixel(row: number, col: number): { x: number; y: number } {
  return {
    x: GRID.offsetX + col * (GRID.tileSize + GRID.gap) + GRID.tileSize / 2,
    y: GRID.offsetY + row * (GRID.tileSize + GRID.gap) + GRID.tileSize / 2,
  };
}

// ピクセル座標 → グリッド座標変換（タッチ入力用）
function pixelToGrid(x: number, y: number): { row: number; col: number } | null {
  const col = Math.floor((x - GRID.offsetX) / (GRID.tileSize + GRID.gap));
  const row = Math.floor((y - GRID.offsetY) / (GRID.tileSize + GRID.gap));
  if (col < 0 || col >= GRID.cols || row < 0 || row >= GRID.rows) return null;
  return { row, col };
}
\`\`\`

### 4.2 マッチ判定（マッチ3系）

\`\`\`typescript
function findMatches(grid: (TileData | null)[][]): Set<string> {
  const matched = new Set<string>();

  // 横方向スキャン
  for (let row = 0; row < GRID.rows; row++) {
    for (let col = 0; col <= GRID.cols - 3; col++) {
      const t1 = grid[row][col];
      const t2 = grid[row][col + 1];
      const t3 = grid[row][col + 2];
      if (t1 && t2 && t3 &&
          t1.colorIndex === t2.colorIndex &&
          t2.colorIndex === t3.colorIndex) {
        matched.add(\`\${row},\${col}\`);
        matched.add(\`\${row},\${col + 1}\`);
        matched.add(\`\${row},\${col + 2}\`);
      }
    }
  }

  // 縦方向スキャン
  for (let col = 0; col < GRID.cols; col++) {
    for (let row = 0; row <= GRID.rows - 3; row++) {
      const t1 = grid[row][col];
      const t2 = grid[row + 1][col];
      const t3 = grid[row + 2][col];
      if (t1 && t2 && t3 &&
          t1.colorIndex === t2.colorIndex &&
          t2.colorIndex === t3.colorIndex) {
        matched.add(\`\${row},\${col}\`);
        matched.add(\`\${row + 1},\${col}\`);
        matched.add(\`\${row + 2},\${col}\`);
      }
    }
  }

  return matched;
}
\`\`\`

### 4.3 重力落下処理

\`\`\`typescript
function applyGravity(grid: (TileData | null)[][]): void {
  for (let col = 0; col < GRID.cols; col++) {
    let writeRow = GRID.rows - 1;
    for (let row = GRID.rows - 1; row >= 0; row--) {
      if (grid[row][col] !== null) {
        if (writeRow !== row) {
          grid[writeRow][col] = grid[row][col];
          grid[row][col] = null;
        }
        writeRow--;
      }
    }
    // 上部の空きを新タイルで埋める
    for (let row = writeRow; row >= 0; row--) {
      grid[row][col] = createRandomTile();
    }
  }
}
\`\`\`

### 4.4 連鎖処理（マッチ → 消去 → 落下 → 再マッチ）

\`\`\`typescript
async function resolveMatches(scene: Phaser.Scene): Promise<void> {
  let matches = findMatches(grid);
  let chainCount = 0;

  while (matches.size > 0) {
    chainCount++;

    // 消去 + スコア加算（連鎖ボーナス）
    for (const key of matches) {
      const [row, col] = key.split(',').map(Number);
      grid[row][col] = null;
      gameState.addScore(SCORING.basePoints);
    }
    gameState.incrementCombo();

    // 落下 + 補充
    applyGravity(grid);
    redrawGrid(scene);

    // アニメーション待機
    await delay(scene, TIMING.matchDelay);

    // 次のマッチ確認（連鎖）
    matches = findMatches(grid);
  }

  gameState.resetCombo();
}
\`\`\`

### 4.5 落ちものパズルパターン（テトリス/ぷよぷよ系）

マッチ3との主な違い:
- タイマーベースの自動落下（\`scene.time.addEvent\`）
- アクティブピース（操作中）とフィールド（固定済み）の分離
- 回転処理（SRS: Super Rotation System 等）
- 接地判定と猶予時間（ロックディレイ）

\`\`\`typescript
// 自動落下タイマー
this.fallTimer = this.time.addEvent({
  delay: this.fallSpeed,        // レベルに応じて短縮
  callback: () => this.moveDown(),
  loop: true,
});

// レベルアップで速度変更
function getFallSpeed(level: number): number {
  return Math.max(100, 1000 - (level - 1) * 80);
}

// アクティブピースの落下
function moveDown(): void {
  if (canMove(activePiece, 0, 1)) {
    activePiece.row++;
  } else {
    lockPiece();         // フィールドに固定
    clearLines();        // ライン消去判定
    spawnNewPiece();     // 新ピース生成
  }
}
\`\`\`

### 4.6 スライドパズルパターン

\`\`\`typescript
// 空きマスの隣だけ移動可能
function canSlide(row: number, col: number): boolean {
  const dr = Math.abs(row - emptyRow);
  const dc = Math.abs(col - emptyCol);
  return (dr === 1 && dc === 0) || (dr === 0 && dc === 1);
}

// クリア判定
function isSolved(): boolean {
  let expected = 1;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (r === size - 1 && c === size - 1) return grid[r][c] === 0;
      if (grid[r][c] !== expected) return false;
      expected++;
    }
  }
  return true;
}
\`\`\`

---

## 5. 入力処理（モバイルファースト）

### タッチ/クリック統合

\`\`\`typescript
// タップ（パズルのタイル選択）
this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
  const gridPos = pixelToGrid(pointer.x, pointer.y);
  if (gridPos) this.onTileClick(gridPos.row, gridPos.col);
});
\`\`\`

### スワイプ検出（落ちもの系）

\`\`\`typescript
private startPointer: { x: number; y: number } | null = null;
private readonly SWIPE_THRESHOLD = 50;

this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
  this.startPointer = { x: pointer.x, y: pointer.y };
});

this.input.on('pointerup', (pointer: Phaser.Input.Pointer) => {
  if (!this.startPointer) return;
  const dx = pointer.x - this.startPointer.x;
  const dy = pointer.y - this.startPointer.y;

  if (Math.abs(dx) > this.SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
    dx > 0 ? this.moveRight() : this.moveLeft();
  } else if (Math.abs(dy) > this.SWIPE_THRESHOLD && Math.abs(dy) > Math.abs(dx)) {
    dy > 0 ? this.hardDrop() : this.rotate();
  }

  this.startPointer = null;
});
\`\`\`

### キーボード（PC フォールバック）

\`\`\`typescript
const cursors = this.input.keyboard!.createCursorKeys();

// update() 内
if (cursors.left.isDown) this.moveLeft();
if (cursors.right.isDown) this.moveRight();
if (cursors.down.isDown) this.softDrop();
if (Phaser.Input.Keyboard.JustDown(cursors.up)) this.rotate();
if (Phaser.Input.Keyboard.JustDown(cursors.space)) this.hardDrop();
\`\`\`

### タッチターゲットサイズ

モバイルでの操作性を確保するため、タップ可能な要素は **最低 44px** を確保する。
\`GRID.tileSize = 64\` は十分なサイズ。

---

## 6. アニメーション

### Tween（パズルゲームの主力）

\`\`\`typescript
// タイル消滅アニメーション
scene.tweens.add({
  targets: sprite,
  scaleX: 0,
  scaleY: 0,
  alpha: 0,
  duration: 200,
  ease: 'Power2',
  onComplete: () => sprite.destroy(),
});

// タイル落下アニメーション
scene.tweens.add({
  targets: sprite,
  y: targetY,
  duration: TIMING.fallDuration,
  ease: 'Bounce.easeOut',
});

// スコアポップアップ
const text = scene.add.text(x, y, \`+\${points}\`, {
  fontSize: '24px', color: '#ffff00'
});
scene.tweens.add({
  targets: text,
  y: y - 40,
  alpha: 0,
  duration: 800,
  onComplete: () => text.destroy(),
});
\`\`\`

### パーティクル（消去エフェクト）

\`\`\`typescript
// Graphics ベースの簡易パーティクル（アセット不要）
function spawnParticles(scene: Phaser.Scene, x: number, y: number, color: number): void {
  for (let i = 0; i < 8; i++) {
    const particle = scene.add.circle(x, y, 4, color);
    const angle = (i / 8) * Math.PI * 2;
    const speed = Phaser.Math.Between(80, 160);

    scene.tweens.add({
      targets: particle,
      x: x + Math.cos(angle) * speed,
      y: y + Math.sin(angle) * speed,
      alpha: 0,
      scaleX: 0.2,
      scaleY: 0.2,
      duration: 400,
      ease: 'Power2',
      onComplete: () => particle.destroy(),
    });
  }
}
\`\`\`

---

## 7. アセット管理

### BootScene パターン（プログレスバー付き）

\`\`\`typescript
class BootScene extends Phaser.Scene {
  constructor() { super({ key: 'BootScene' }); }

  preload(): void {
    const { width, height } = this.cameras.main;

    // プログレスバー
    const progressBox = this.add.graphics();
    const progressBar = this.add.graphics();
    progressBox.fillStyle(0x222222, 0.8);
    progressBox.fillRect(width / 2 - 160, height / 2 - 25, 320, 50);

    this.load.on('progress', (value: number) => {
      progressBar.clear();
      progressBar.fillStyle(0xffffff, 1);
      progressBar.fillRect(width / 2 - 150, height / 2 - 15, 300 * value, 30);
    });

    // アセットがあればここでロード
    // this.load.image('tile', 'assets/tile.png');
    // this.load.audio('match', 'assets/match.mp3');
  }

  create(): void {
    this.scene.start('MenuScene');
  }
}
\`\`\`

### プロシージャル描画（アセット不要アプローチ）

パズルゲームのプロトタイプでは、画像アセットなしで Graphics API だけで描画できる。
これにより **ゼロアセットで即動くゲーム** が実現可能。

\`\`\`typescript
// 角丸タイル
const g = this.add.graphics();
g.fillStyle(COLORS.tiles[colorIndex], 1);
g.fillRoundedRect(x - size / 2, y - size / 2, size, size, 8);

// グロー効果
g.lineStyle(2, 0xffffff, 0.3);
g.strokeRoundedRect(x - size / 2, y - size / 2, size, size, 8);
\`\`\`

---

## 8. モバイル対応

### スケーリング設定

\`\`\`typescript
scale: {
  mode: Phaser.Scale.FIT,          // アスペクト比維持でフィット
  autoCenter: Phaser.Scale.CENTER_BOTH,
},
\`\`\`

### 画面サイズ戦略

- **480 x 720** をベースサイズに採用（モバイル縦持ち最適）
- \`Scale.FIT\` で大画面にも自動対応
- UI 要素はベースサイズの相対座標で配置

### meta viewport

\`\`\`html
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no" />
\`\`\`

### iOS セーフエリア

\`\`\`css
body {
  padding: env(safe-area-inset-top) env(safe-area-inset-right)
           env(safe-area-inset-bottom) env(safe-area-inset-left);
}
\`\`\`

---

## 9. パフォーマンス最適化

### オブジェクトプーリング

頻繁に生成/破棄するオブジェクト（パーティクル、弾等）はプールで再利用:

\`\`\`typescript
// Phaser Group をプールとして使用
const particles = this.add.group({
  classType: Phaser.GameObjects.Arc,
  maxSize: 50,
  runChildUpdate: false,
});

// 取得
const p = particles.get(x, y) as Phaser.GameObjects.Arc;
if (p) {
  p.setActive(true).setVisible(true);
  // 使い終わったら
  p.setActive(false).setVisible(false);
}
\`\`\`

### 描画最適化

- **毎フレーム全再描画しない** — 変更があったタイルだけ更新
- **Graphics オブジェクトの再利用** — \`clear()\` して再描画、\`destroy()\` + \`new\` を避ける
- **テクスチャアトラス** — 複数画像を1枚にまとめて draw call 削減
- **可視範囲外の非表示** — \`setVisible(false)\` で描画スキップ

### メモリ管理

- \`destroy()\` 忘れに注意（特にシーン遷移時）
- イベントリスナーは \`scene.events.once\` または \`shutdown\` で解除
- 大量の \`new\` を \`update()\` 内で避ける

---

## 10. アンチパターン（避けるべきこと）

| ❌ やってはいけない | ✅ 正しいアプローチ |
|-------------------|-------------------|
| グローバル変数 / \`window\` に状態保存 | GameState クラスで一元管理 |
| \`create()\` 内でアセットロード | \`preload()\` で必ずロード |
| フレームカウントで速度制御 | \`delta / 1000\` で時間ベース計算 |
| パズルに物理エンジン使用 | 論理グリッド + Tween アニメーション |
| 1つの巨大シーンに全ロジック | 機能別にシーン分割 |
| マジックナンバー散在 | \`constants.ts\` に集約 |
| 毎フレーム \`new\` + \`destroy\` | オブジェクトプーリング |
| スプライトシートのサイズを推測 | 実アセットを開いて正確に測定 |
| キーボード入力だけ実装 | タッチ入力をまず実装、キーボードはフォールバック |

---

## 11. ジャンル別改造ガイド

サンプルのマッチ3から他のパズルジャンルへの改造指針:

### マッチ3 → 落ちもの（テトリス/ぷよぷよ系）

1. グリッドの入力処理をタップ選択からスワイプ操作に変更
2. \`time.addEvent\` で自動落下タイマーを追加
3. アクティブピースとフィールドを分離
4. マッチ判定を横1列完成（テトリス）or 同色4連結（ぷよぷよ）に変更
5. レベルアップで落下速度を加速

### マッチ3 → スライドパズル

1. グリッドの1マスを空きマスに変更
2. 入力をタイル交換から空きマスへのスライドに変更
3. マッチ判定をクリア判定（正しい並び順）に変更
4. 移動回数カウンターを追加

### マッチ3 → 数独系

1. グリッドを 9x9 に変更、3x3 ブロック境界線を追加
2. タイルの色を数字（1-9）に変更
3. 入力を数字選択パネル + タップ配置に変更
4. バリデーション（行/列/ブロック重複チェック）を追加
5. 初期配置の固定マスと入力可能マスを区別

---

## 12. Phaser クイックリファレンス

### シーン操作

\`\`\`typescript
this.scene.start('SceneKey', data);    // 開始（現在のシーン停止）
this.scene.launch('SceneKey');         // 並列起動
this.scene.stop('SceneKey');           // 停止
this.scene.pause('SceneKey');          // 一時停止
this.scene.resume('SceneKey');         // 再開
this.scene.get('SceneKey');            // シーン参照取得
\`\`\`

### テキスト

\`\`\`typescript
this.add.text(x, y, 'Hello', {
  fontSize: '24px',
  color: '#ffffff',
  fontFamily: 'Arial, sans-serif',
}).setOrigin(0.5);  // 中央揃え
\`\`\`

### Tween

\`\`\`typescript
this.tweens.add({
  targets: sprite,
  x: 100, y: 200,        // 移動先
  scaleX: 1.2,            // 拡大
  alpha: 0,               // フェードアウト
  duration: 500,          // ミリ秒
  ease: 'Power2',         // イージング
  yoyo: true,             // 往復
  repeat: -1,             // 無限リピート
  onComplete: () => {},   // 完了コールバック
});
\`\`\`

### タイマー

\`\`\`typescript
// 一回だけ
this.time.delayedCall(1000, () => { /* 1秒後 */ });

// 繰り返し
this.time.addEvent({
  delay: 500,
  callback: () => { /* 0.5秒ごと */ },
  loop: true,
});
\`\`\`

### ユーティリティ

\`\`\`typescript
Phaser.Math.Between(min, max);           // ランダム整数
Phaser.Math.FloatBetween(min, max);      // ランダム小数
Phaser.Math.Clamp(value, min, max);      // 範囲制限
Phaser.Utils.Array.Shuffle(array);       // 配列シャッフル
\`\`\`

### Promise ベースの遅延（async/await 対応）

\`\`\`typescript
function delay(scene: Phaser.Scene, ms: number): Promise<void> {
  return new Promise(resolve => scene.time.delayedCall(ms, resolve));
}

// 使い方
await delay(this, 300);
\`\`\`

---

## 13. オーディオ（効果音 + BGM）

「音楽つけて」「効果音実装して」「BGM 追加して」等の指示で発動。
jsfxr（効果音）+ Tone.js（BGM）で**音声ファイルゼロ**のプロシージャルオーディオを実装する。

### 依存パッケージ

\`\`\`json
{
  "dependencies": {
    "jsfxr": "^1.2.2",
    "tone": "^15.0.0"
  }
}
\`\`\`

### 13.1 AudioManager（必須テンプレート）

全てのオーディオ操作を一元管理するクラス。モバイル対応の初期化処理を含む。

\`\`\`typescript
// src/systems/AudioManager.ts
import * as Tone from 'tone';
import { sfxr } from 'jsfxr';

export class AudioManager {
  private static instance: AudioManager;
  private initialized = false;
  private muted = false;
  private bgmPlaying = false;
  private melodyPart: Tone.Sequence | null = null;
  private bassPart: Tone.Sequence | null = null;
  private drumPart: Tone.Sequence | null = null;

  static getInstance(): AudioManager {
    if (!AudioManager.instance) {
      AudioManager.instance = new AudioManager();
    }
    return AudioManager.instance;
  }

  // ★ 重要: iOS では最初のユーザー操作時に呼ぶ必要がある
  async init(): Promise<void> {
    if (this.initialized) return;
    await Tone.start();
    this.initialized = true;
  }

  // ミュート切り替え（UI ボタンから呼ぶ）
  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.muted) {
      Tone.getDestination().volume.value = -Infinity;
    } else {
      Tone.getDestination().volume.value = 0;
    }
    return this.muted;
  }

  get isMuted(): boolean { return this.muted; }
}
\`\`\`

### 13.2 iOS / モバイル初期化の注意

**iOS は最初のユーザー操作（タップ/クリック）後にしか AudioContext を開始できない。**

\`\`\`typescript
// GameScene.ts の create() 内
this.input.once('pointerdown', async () => {
  await AudioManager.getInstance().init();
});
\`\`\`

タイトル画面の「Start」ボタンタップ時に init() するのがベストプラクティス。

### 13.3 効果音（jsfxr）

#### プリセット対応表（パズルゲーム向け）

| ゲームイベント | jsfxr プリセット | 説明 |
|--------------|----------------|------|
| タイル選択 | \`blipSelect\` | 軽いクリック音 |
| マッチ成功 | \`pickupCoin\` | コイン取得系の心地よい音 |
| 連鎖（コンボ） | \`powerUp\` | 上昇感のある音 |
| マッチ失敗 / 無効操作 | \`hitHurt\` | 短い否定音 |
| レベルアップ | \`powerUp\` + ピッチ上げ | 達成感のある音 |
| ゲームオーバー | \`explosion\` | 低めの衝撃音 |
| タイル落下 | \`jump\` | 軽い着地音 |

#### 実装パターン

\`\`\`typescript
// AudioManager に追加
playSfx(type: 'match' | 'combo' | 'drop' | 'select' | 'fail' | 'levelup' | 'gameover'): void {
  if (this.muted) return;

  const presets: Record<string, string> = {
    select:  'blipSelect',
    match:   'pickupCoin',
    combo:   'powerUp',
    drop:    'jump',
    fail:    'hitHurt',
    levelup: 'powerUp',
    gameover: 'explosion',
  };

  const preset = presets[type];
  if (preset) {
    const sound = sfxr.generate(preset);
    sfxr.play(sound);
  }
}
\`\`\`

#### カスタム効果音

sfxr.me エディタで音を調整 → 「serialize」→ JSON をコードに埋め込み:

\`\`\`typescript
// カスタムマッチ音（sfxr.me で作成した JSON パラメータ）
private customMatchSound = {
  oldParams: true,
  wave_type: 1,
  p_env_attack: 0,
  p_env_sustain: 0.03,
  p_env_punch: 0.55,
  p_env_decay: 0.44,
  p_base_freq: 0.68,
  // ... 省略（sfxr.me からコピー）
  sound_vol: 0.25,
  sample_rate: 44100,
  sample_size: 16,
};

playCustomMatch(): void {
  if (this.muted) return;
  sfxr.play(sfxr.toAudio(this.customMatchSound));
}
\`\`\`

### 13.4 BGM（Tone.js）

#### チップチューン BGM 基本構成

パズルゲームの BGM は通常3パート構成:

| パート | 波形 | 役割 |
|--------|------|------|
| **メロディ** | square / pulse | 主旋律 |
| **ベース** | triangle | 低音のリズム |
| **ドラム** | noise + envelope | パーカッション |

#### ムード別コード進行テンプレート

**明るい・ポップ（マッチ3、カジュアル系）**
\`\`\`
キー: C Major
進行: C → G → Am → F（I → V → vi → IV）
テンポ: 120-140 BPM
\`\`\`

**緊張感・スピーディ（落ちもの系）**
\`\`\`
キー: A Minor
進行: Am → F → C → G（i → VI → III → VII）
テンポ: 140-160 BPM、レベルアップで加速
\`\`\`

**リラックス・穏やか（数独、スライド系）**
\`\`\`
キー: F Major
進行: F → Dm → Bb → C（I → vi → IV → V）
テンポ: 80-100 BPM
\`\`\`

#### 実装例: 明るいパズル BGM

\`\`\`typescript
// AudioManager に追加
startBGM(): void {
  if (this.bgmPlaying || this.muted) return;

  const bpm = 130;
  Tone.getTransport().bpm.value = bpm;

  // メロディ（square 波）
  const melody = new Tone.Synth({
    oscillator: { type: 'square' },
    envelope: { attack: 0.005, decay: 0.1, sustain: 0.3, release: 0.1 },
    volume: -12,
  }).toDestination();

  this.melodyPart = new Tone.Sequence((time, note) => {
    if (note !== null) melody.triggerAttackRelease(note, '8n', time);
  }, [
    'C5', 'E5', 'G5', 'E5',  'C5', 'D5', 'E5', null,
    'A4', 'C5', 'E5', 'C5',  'A4', 'B4', 'C5', null,
    'F4', 'A4', 'C5', 'A4',  'G4', 'B4', 'D5', null,
    'G4', 'B4', 'D5', 'B4',  'C5', null, null, null,
  ], '8n').start(0);

  // ベースライン（triangle 波）
  const bass = new Tone.Synth({
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.01, decay: 0.2, sustain: 0.4, release: 0.2 },
    volume: -8,
  }).toDestination();

  this.bassPart = new Tone.Sequence((time, note) => {
    if (note !== null) bass.triggerAttackRelease(note, '4n', time);
  }, [
    'C2', null, 'G2', null,  'C2', null, 'G2', null,
    'A1', null, 'E2', null,  'A1', null, 'E2', null,
    'F1', null, 'C2', null,  'G1', null, 'D2', null,
    'G1', null, 'D2', null,  'C2', null, null, null,
  ], '8n').start(0);

  // ドラム（ノイズ系）
  const kick = new Tone.MembraneSynth({ volume: -10 }).toDestination();
  const hihat = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.01 },
    volume: -18,
  }).toDestination();

  this.drumPart = new Tone.Sequence((time, note) => {
    if (note === 'k') kick.triggerAttackRelease('C1', '8n', time);
    if (note === 'h') hihat.triggerAttackRelease('16n', time);
  }, [
    'k', 'h', null, 'h',  'k', 'h', null, 'h',
    'k', 'h', null, 'h',  'k', 'h', 'k', 'h',
  ], '8n').start(0);

  Tone.getTransport().start();
  this.bgmPlaying = true;
}

stopBGM(): void {
  this.melodyPart?.dispose();
  this.bassPart?.dispose();
  this.drumPart?.dispose();
  Tone.getTransport().stop();
  this.bgmPlaying = false;
}
\`\`\`

#### レベルに応じた BGM 変化（落ちもの系）

\`\`\`typescript
// レベルアップ時にテンポを加速
updateBGMTempo(level: number): void {
  const baseBPM = 120;
  const newBPM = Math.min(baseBPM + (level - 1) * 8, 200);
  Tone.getTransport().bpm.rampTo(newBPM, 0.5);  // 0.5秒かけて変化
}
\`\`\`

### 13.5 ゲームシーンへの組み込み

\`\`\`typescript
// GameScene.ts
import { AudioManager } from '../systems/AudioManager';

class GameScene extends Phaser.Scene {
  private audio = AudioManager.getInstance();

  create(): void {
    // タイトル or 最初のタップで初期化
    this.input.once('pointerdown', async () => {
      await this.audio.init();
      this.audio.startBGM();
    });
  }

  // マッチ成功時
  private onMatch(count: number): void {
    if (count >= 4) {
      this.audio.playSfx('combo');
    } else {
      this.audio.playSfx('match');
    }
  }

  // タイル選択時
  private onTileSelect(): void {
    this.audio.playSfx('select');
  }

  // ゲームオーバー
  private onGameOver(): void {
    this.audio.stopBGM();
    this.audio.playSfx('gameover');
  }
}
\`\`\`

### 13.6 ミュートボタン UI

\`\`\`typescript
// UIScene.ts に追加
const muteBtn = this.add.text(SCREEN.width - 50, 20, '🔊', {
  fontSize: '28px',
}).setInteractive().setOrigin(0.5);

muteBtn.on('pointerdown', () => {
  const muted = AudioManager.getInstance().toggleMute();
  muteBtn.setText(muted ? '🔇' : '🔊');
});
\`\`\`

### 13.7 オーディオ設計のルール

- **音声ファイルは使わない** — jsfxr + Tone.js でプロシージャル生成
- **AudioManager シングルトン** — 全シーンから同じインスタンスを参照
- **iOS 初期化** — ユーザー操作後に \`Tone.start()\` を必ず呼ぶ
- **ミュート対応** — 全ゲームにミュートボタンを必須で実装
- **BGM はループ** — \`Tone.Sequence\` の \`loop = true\`（デフォルト）
- **効果音は短く** — 200ms 以下が目安、BGM と干渉しないよう音量バランス調整
- **レベル連動** — 落ちもの系はレベルに応じてテンポ加速

---

## 14. 対戦基盤（Multiplayer Infrastructure）

### 14.1 アーキテクチャ概要

テンプレートには WebSocket ベースの対戦基盤が内蔵されている。

- **サーバー権威型**: ゲーム状態はサーバー（\`server/room.ts\`）が管理
- **Vite プラグイン**: dev サーバーと同一ポートで WS を提供
- **GameAdapter パターン**: ゲーム固有ロジックをアダプタとして抽象化

### 14.2 ゲームを変更する手順

1. \`server/adapters/\` に新しいアダプタクラスを作成
2. \`GameAdapter\` インターフェースを実装（\`server/game-adapter.ts\` 参照）
3. \`server/adapters/index.ts\` の export を新アダプタに差し替え
4. \`src/scenes/GameScene.ts\` の描画・入力を新ゲームに合わせて変更
5. \`src/scenes/LobbyScene.ts\` のゲーム名・ルール説明を更新

### 14.3 GameAdapter インターフェース

\`\`\`typescript
interface GameAdapter {
  name: string;                    // ゲーム名
  createInitialState(): GameState; // 初期状態
  applyMove(state, player, action): MoveResult; // 手の適用
  getCpuMove(state, cpuPlayer): any;            // CPU の手
  getPlayerView(state, player): GameState;      // 表示用状態
}
\`\`\`

### 14.4 マッチメイキング

- \`server/matchmaker.ts\` が FIFO キュー管理
- 10秒以内にマッチすれば PvP、タイムアウトで CPU 戦
- \`MATCH_TIMEOUT_MS\` 定数で待ち時間を調整可能

### 14.5 対戦の注意事項

- ゲーム状態の変更は必ずサーバー側（Room + GameAdapter）で行う
- クライアントは \`move\` メッセージで行動を送信し、\`state\` メッセージで結果を受け取る
- 不完全情報ゲーム（手札など）は \`getPlayerView()\` で各プレイヤーの見える情報を制限
- CPU の手は 500〜1500ms の遅延で実行（自然な感覚に）
`;
