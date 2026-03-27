/**
 * Phaser ゲームテンプレート定義
 *
 * testflight create --phaser で展開されるファイル群。
 * プレースホルダー: {{NAME}} → サービス名, {{PORT}} → ポート番号
 *
 * 2048 パズルゲーム + BGM/SFX オーディオ対応のサンプル付き。
 * tetris.devrelay.io の実装をベースにテンプレート化。
 */

import { PHASER_SKILL_MD } from './phaser-skill-template.js';

/** PHASER_SKILL_MD を re-export（testflight-manager から使えるように） */
export { PHASER_SKILL_MD };

/** package.json テンプレート（jsfxr + tone 込み） */
export const PHASER_PACKAGE_JSON = `{
  "name": "{{NAME}}",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "phaser": "^3.87.0",
    "jsfxr": "^1.2.2",
    "tone": "^15.0.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vite": "^6.0.0"
  }
}
`;

/** vite.config.ts テンプレート */
export const PHASER_VITE_CONFIG = `import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    allowedHosts: ['{{NAME}}.devrelay.io'],
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  // Safari が ?.map リクエストを送った際に esbuild がクラッシュしないようにする
  optimizeDeps: {
    esbuildOptions: {
      loader: {
        '.map': 'json',
      },
    },
  },
});
`;

/** tsconfig.json テンプレート */
export const PHASER_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "sourceMap": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "include": ["src"]
}
`;

/** index.html テンプレート（モバイル最適化: viewport-fit=cover + dvh + safe-area） */
export const PHASER_INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no, viewport-fit=cover" />
  <title>{{NAME}} - DevRelay Game</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #faf8ef; overflow: hidden; }
    #game-container {
      width: 100%;
      height: 100vh;
      height: 100dvh;
      padding-bottom: env(safe-area-inset-bottom, 0px);
    }
  </style>
</head>
<body>
  <div id="game-container"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
`;

/** src/main.ts テンプレート */
export const PHASER_MAIN_TS = `import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene';
import { GameScene } from './scenes/GameScene';
import { UIScene } from './scenes/UIScene';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game-container',
  width: 480,
  height: 720,
  backgroundColor: '#faf8ef',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [BootScene, GameScene, UIScene],
};

new Phaser.Game(config);
`;

/** src/scenes/BootScene.ts テンプレート */
export const PHASER_BOOT_SCENE = `import Phaser from 'phaser';

export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BootScene' });
  }

  create(): void {
    this.scene.start('GameScene');
  }
}
`;

/**
 * src/utils/SoundManager.ts テンプレート
 * Tone.js で BGM（チルなコード進行ループ）+ jsfxr で SFX（move, merge, spawn, gameOver）
 * シングルトンパターン、iOS AudioContext 初期化対応
 */
export const PHASER_SOUND_MANAGER = `import * as Tone from 'tone';
import { sfxr } from 'jsfxr';

/** jsfxr の toAudio が返す再生可能オブジェクト */
interface SfxrPlayer {
  setVolume(v: number): SfxrPlayer;
  play(): void;
}

/**
 * BGM + 効果音を管理するシングルトン。
 * - BGM: Tone.js でシンセループを生成
 * - SFX: jsfxr でレトロ風効果音を生成
 * - 外部音声ファイル不要
 */
export class SoundManager {
  private static instance: SoundManager;

  private bgmMuted = true;
  private sfxMuted = false;
  private started = false;
  private bgmPlaying = false;

  /* ---- Tone.js BGM ---- */
  private synth!: Tone.PolySynth;
  private bgmLoop!: Tone.Pattern<string[]>;
  private bgmGain!: Tone.Gain;

  /* ---- jsfxr SFX (synthdef パラメータを保持) ---- */
  private sfxMoveDef!: object;
  private sfxMergeDef!: object;
  private sfxGameOverDef!: object;

  private constructor() {
    this.initSFX();
    this.initBGM();
  }

  static getInstance(): SoundManager {
    if (!SoundManager.instance) {
      SoundManager.instance = new SoundManager();
    }
    return SoundManager.instance;
  }

  /* ==============================================================
   *  初期化
   * ============================================================== */

  private initSFX(): void {
    // move: 短い blip 音
    this.sfxMoveDef = sfxr.generate('blipSelect', { sound_vol: 0.15 });

    // merge: pickupCoin 系
    this.sfxMergeDef = sfxr.generate('pickupCoin', { sound_vol: 0.2 });

    // gameOver: hitHurt 系
    this.sfxGameOverDef = sfxr.generate('hitHurt', { sound_vol: 0.25 });
  }

  private initBGM(): void {
    this.bgmGain = new Tone.Gain(0).toDestination();

    this.synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: {
        attack: 0.3,
        decay: 0.4,
        sustain: 0.4,
        release: 1.2,
      },
    }).connect(this.bgmGain);

    // コード進行: チルなループ
    const chords = [
      ['C4', 'E4', 'G4', 'B4'],   // Cmaj7
      ['A3', 'C4', 'E4', 'G4'],   // Am7
      ['F3', 'A3', 'C4', 'E4'],   // Fmaj7
      ['G3', 'B3', 'D4', 'F4'],   // G7
    ];

    this.bgmLoop = new Tone.Pattern(
      (time, chord) => {
        if (chord) {
          this.synth.triggerAttackRelease(chord, '2n', time, 0.3);
        }
      },
      chords,
      'up',
    );
    this.bgmLoop.interval = '1m';
  }

  /* ==============================================================
   *  AudioContext の起動 (iOS 対応)
   * ============================================================== */

  async ensureStarted(): Promise<void> {
    if (this.started) return;
    try {
      await Tone.start();
      this.started = true;
    } catch {
      // AudioContext 起動失敗は無視（音が出ないだけ）
    }
  }

  /* ==============================================================
   *  BGM
   * ============================================================== */

  async startBGM(): Promise<void> {
    await this.ensureStarted();
    if (this.bgmPlaying) return;
    Tone.getTransport().bpm.value = 70;
    this.bgmLoop.start(0);
    Tone.getTransport().start();
    this.bgmPlaying = true;
  }

  stopBGM(): void {
    if (!this.bgmPlaying) return;
    this.bgmLoop.stop();
    Tone.getTransport().stop();
    this.bgmPlaying = false;
  }

  /* ==============================================================
   *  SFX
   * ============================================================== */

  playMove(): void {
    this.playSFX(this.sfxMoveDef, 0.3);
  }

  playMerge(_value: number): void {
    this.playSFX(this.sfxMergeDef, 0.5);
  }

  playSpawn(): void {
    // タイル出現音（merge と同じ音を小さめに）
    this.playSFX(this.sfxMergeDef, 0.2);
  }

  playGameOver(): void {
    this.playSFX(this.sfxGameOverDef, 0.6);
  }

  /** synthdef から直接再生（jsfxr の toAudio は独自 player を返す） */
  private playSFX(synthdef: object, volume: number): void {
    if (this.sfxMuted || !synthdef) return;
    try {
      const player = sfxr.toAudio(synthdef) as unknown as SfxrPlayer;
      player.setVolume(volume);
      player.play();
    } catch {
      // 再生失敗は無視
    }
  }

  /* ==============================================================
   *  ミュート
   * ============================================================== */

  toggleBGM(): boolean {
    this.bgmMuted = !this.bgmMuted;
    this.bgmGain.gain.value = this.bgmMuted ? 0 : 0.12;
    return this.bgmMuted;
  }

  toggleSFX(): boolean {
    this.sfxMuted = !this.sfxMuted;
    return this.sfxMuted;
  }

  isBGMMuted(): boolean {
    return this.bgmMuted;
  }

  isSFXMuted(): boolean {
    return this.sfxMuted;
  }
}
`;

/**
 * src/types/jsfxr.d.ts テンプレート
 * jsfxr パッケージの TypeScript 型定義
 */
export const PHASER_JSFXR_DTS = `declare module 'jsfxr' {
  interface SfxrOptions {
    sound_vol?: number;
    sample_rate?: number;
    sample_size?: number;
  }

  interface Sfxr {
    generate(
      algorithm: 'pickupCoin' | 'laserShoot' | 'explosion' | 'powerUp' | 'hitHurt' | 'jump' | 'blipSelect' | 'synth' | 'tone' | 'click' | 'random',
      options?: SfxrOptions,
    ): object;
    toAudio(synthdef: object): HTMLAudioElement;
    play(synthdef: object): HTMLAudioElement;
    toWave(synthdef: object): object;
    toWebAudio(synthdef: object, ctx?: AudioContext): AudioBuffer;
  }

  export const sfxr: Sfxr;
  export const jsfxr: object;
}
`;

/** src/scenes/GameScene.ts テンプレート（2048 + SoundManager 統合） */
export const PHASER_GAME_SCENE = `import Phaser from 'phaser';
import { SoundManager } from '../utils/SoundManager';

/** グリッドサイズ */
const SIZE = 4;
/** タイルの大きさ (px) */
const TILE_SIZE = 100;
/** タイル間の隙間 (px) */
const GAP = 12;
/** グリッド全体の幅 */
const GRID_PX = SIZE * TILE_SIZE + (SIZE + 1) * GAP;
/** グリッドの左上 X */
const OFFSET_X = (480 - GRID_PX) / 2;
/** グリッドの左上 Y */
const OFFSET_Y = 160;

/** 数値ごとのタイル背景色 */
const TILE_BG: Record<number, number> = {
  2:    0xeee4da,
  4:    0xede0c8,
  8:    0xf2b179,
  16:   0xf59563,
  32:   0xf67c5f,
  64:   0xf65e3b,
  128:  0xedcf72,
  256:  0xedcc61,
  512:  0xedc850,
  1024: 0xedc53f,
  2048: 0xedc22e,
};

/** 数値ごとの文字色 */
const TILE_FG: Record<number, string> = {
  2:   '#776e65',
  4:   '#776e65',
};
const LIGHT_TEXT = '#f9f6f2';

/** スワイプ判定の最小距離 */
const SWIPE_THRESHOLD = 40;

export class GameScene extends Phaser.Scene {
  /** 論理グリッド（0 = 空） */
  private grid: number[][] = [];
  private score = 0;
  private gameOver = false;
  private startPointer: { x: number; y: number } | null = null;
  private sound_manager!: SoundManager;
  private bgmStarted = false;

  constructor() {
    super({ key: 'GameScene' });
  }

  create(): void {
    this.score = 0;
    this.gameOver = false;
    this.bgmStarted = false;
    this.grid = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
    this.sound_manager = SoundManager.getInstance();
    this.scene.launch('UIScene');

    // 初期タイル 2 枚
    this.spawnTile();
    this.spawnTile();
    this.drawBoard();

    // スワイプ入力
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      this.startPointer = { x: p.x, y: p.y };
      // 初回タッチで BGM 開始（iOS AudioContext 対応）
      this.tryStartBGM();
    });
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => {
      if (!this.startPointer || this.gameOver) return;
      const dx = p.x - this.startPointer.x;
      const dy = p.y - this.startPointer.y;
      this.startPointer = null;
      if (Math.abs(dx) < SWIPE_THRESHOLD && Math.abs(dy) < SWIPE_THRESHOLD) return;
      if (Math.abs(dx) > Math.abs(dy)) {
        dx > 0 ? this.move('right') : this.move('left');
      } else {
        dy > 0 ? this.move('down') : this.move('up');
      }
    });

    // キーボード入力
    if (this.input.keyboard) {
      this.input.keyboard.on('keydown', (e: KeyboardEvent) => {
        this.tryStartBGM();
        if (this.gameOver) return;
        switch (e.key) {
          case 'ArrowLeft':  this.move('left');  break;
          case 'ArrowRight': this.move('right'); break;
          case 'ArrowUp':    this.move('up');    break;
          case 'ArrowDown':  this.move('down');  break;
        }
      });
    }
  }

  /** 初回操作で BGM を開始 */
  private tryStartBGM(): void {
    if (this.bgmStarted) return;
    this.bgmStarted = true;
    this.sound_manager.startBGM();
  }

  /** 空きマスにランダムで 2 か 4 を配置 */
  private spawnTile(): void {
    const empty: { r: number; c: number }[] = [];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (this.grid[r][c] === 0) empty.push({ r, c });
      }
    }
    if (empty.length === 0) return;
    const { r, c } = Phaser.Utils.Array.GetRandom(empty);
    this.grid[r][c] = Math.random() < 0.9 ? 2 : 4;
  }

  /** 指定方向にスライド＋マージ */
  private move(dir: 'left' | 'right' | 'up' | 'down'): void {
    const prev = this.grid.map(row => [...row]);
    let moved = false;
    let merged = false;
    let maxMergeValue = 0;

    const slide = (line: number[]): number[] => {
      let arr = line.filter(v => v !== 0);
      for (let i = 0; i < arr.length - 1; i++) {
        if (arr[i] === arr[i + 1]) {
          arr[i] *= 2;
          this.score += arr[i];
          if (arr[i] > maxMergeValue) maxMergeValue = arr[i];
          merged = true;
          arr[i + 1] = 0;
          i++;
        }
      }
      arr = arr.filter(v => v !== 0);
      while (arr.length < SIZE) arr.push(0);
      return arr;
    };

    if (dir === 'left' || dir === 'right') {
      for (let r = 0; r < SIZE; r++) {
        let line = this.grid[r];
        if (dir === 'right') line = [...line].reverse();
        line = slide(line);
        if (dir === 'right') line = line.reverse();
        this.grid[r] = line;
      }
    } else {
      for (let c = 0; c < SIZE; c++) {
        let line = this.grid.map(row => row[c]);
        if (dir === 'down') line = [...line].reverse();
        line = slide(line);
        if (dir === 'down') line = line.reverse();
        for (let r = 0; r < SIZE; r++) this.grid[r][c] = line[r];
      }
    }

    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (this.grid[r][c] !== prev[r][c]) moved = true;
      }
    }

    if (moved) {
      // 効果音: マージ > ムーブの優先度
      if (merged) {
        this.sound_manager.playMerge(maxMergeValue);
      } else {
        this.sound_manager.playMove();
      }

      this.spawnTile();
      this.sound_manager.playSpawn();
      this.events.emit('scoreUpdate', this.score);
      this.drawBoard();
      if (this.isGameOver()) {
        this.gameOver = true;
        this.sound_manager.playGameOver();
        this.sound_manager.stopBGM();
        this.events.emit('gameOver', this.score);
      }
    }
  }

  /** ゲームオーバー判定 */
  private isGameOver(): boolean {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (this.grid[r][c] === 0) return false;
        if (c < SIZE - 1 && this.grid[r][c] === this.grid[r][c + 1]) return false;
        if (r < SIZE - 1 && this.grid[r][c] === this.grid[r + 1][c]) return false;
      }
    }
    return true;
  }

  /** 盤面を描画 */
  private drawBoard(): void {
    this.children.removeAll();

    const bg = this.add.graphics();
    bg.fillStyle(0xbbada0, 1);
    bg.fillRoundedRect(OFFSET_X, OFFSET_Y, GRID_PX, GRID_PX, 8);

    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const x = OFFSET_X + GAP + c * (TILE_SIZE + GAP);
        const y = OFFSET_Y + GAP + r * (TILE_SIZE + GAP);
        const val = this.grid[r][c];

        const cellBg = this.add.graphics();
        cellBg.fillStyle(0xcdc1b4, 1);
        cellBg.fillRoundedRect(x, y, TILE_SIZE, TILE_SIZE, 6);

        if (val === 0) continue;

        const tileBg = TILE_BG[val] ?? 0x3c3a32;
        const tile = this.add.graphics();
        tile.fillStyle(tileBg, 1);
        tile.fillRoundedRect(x, y, TILE_SIZE, TILE_SIZE, 6);

        const textColor = TILE_FG[val] ?? LIGHT_TEXT;
        const fontSize = val >= 1024 ? '28px' : val >= 128 ? '32px' : '40px';
        this.add.text(x + TILE_SIZE / 2, y + TILE_SIZE / 2, String(val), {
          fontSize,
          color: textColor,
          fontFamily: 'Arial, Helvetica, sans-serif',
          fontStyle: 'bold',
        }).setOrigin(0.5);
      }
    }
  }
}
`;

/** src/scenes/UIScene.ts テンプレート（BGM/SFX ミュートボタン + ゲームオーバー多重表示防止） */
export const PHASER_UI_SCENE = `import Phaser from 'phaser';
import { SoundManager } from '../utils/SoundManager';

export class UIScene extends Phaser.Scene {
  private scoreText!: Phaser.GameObjects.Text;
  private bgmBtn!: Phaser.GameObjects.Text;
  private sfxBtn!: Phaser.GameObjects.Text;
  private gameOverGroup: Phaser.GameObjects.GameObject[] = [];

  constructor() {
    super({ key: 'UIScene' });
  }

  create(): void {
    const sm = SoundManager.getInstance();

    // タイトル
    this.add.text(240, 40, '2048', {
      fontSize: '52px',
      color: '#776e65',
      fontFamily: 'Arial, Helvetica, sans-serif',
      fontStyle: 'bold',
    }).setOrigin(0.5);

    // スコア
    this.scoreText = this.add.text(240, 90, 'Score: 0', {
      fontSize: '22px',
      color: '#bbada0',
      fontFamily: 'Arial, sans-serif',
      fontStyle: 'bold',
    }).setOrigin(0.5);

    // BGM ミュートボタン（右上）
    const btnStyle = {
      fontSize: '14px',
      color: '#f9f6f2',
      fontFamily: 'Arial, sans-serif',
      fontStyle: 'bold',
      backgroundColor: '#8f7a66',
      padding: { x: 6, y: 4 },
    };

    this.bgmBtn = this.add.text(420, 16, sm.isBGMMuted() ? 'BGM OFF' : 'BGM ON', btnStyle)
      .setOrigin(0.5).setInteractive({ useHandCursor: true });
    this.bgmBtn.on('pointerdown', () => {
      const muted = sm.toggleBGM();
      this.bgmBtn.setText(muted ? 'BGM OFF' : 'BGM ON');
    });

    // SFX ミュートボタン
    this.sfxBtn = this.add.text(420, 44, sm.isSFXMuted() ? 'SFX OFF' : 'SFX ON', btnStyle)
      .setOrigin(0.5).setInteractive({ useHandCursor: true });
    this.sfxBtn.on('pointerdown', () => {
      const muted = sm.toggleSFX();
      this.sfxBtn.setText(muted ? 'SFX OFF' : 'SFX ON');
    });

    // 操作説明
    this.add.text(240, 680, 'スワイプまたは矢印キーでタイルを移動', {
      fontSize: '14px',
      color: '#bbada0',
      fontFamily: 'Arial, sans-serif',
    }).setOrigin(0.5);

    this.add.text(240, 700, '同じ数字がぶつかると合体！ 2048 を目指そう', {
      fontSize: '14px',
      color: '#bbada0',
      fontFamily: 'Arial, sans-serif',
    }).setOrigin(0.5);

    // スコア更新イベント
    const gameScene = this.scene.get('GameScene');
    gameScene.events.on('scoreUpdate', (score: number) => {
      this.scoreText.setText(\`Score: \${score}\`);
    });

    // ゲームオーバーイベント
    gameScene.events.on('gameOver', (score: number) => {
      this.showGameOver(score);
    });
  }

  /** ゲームオーバー表示 + リトライボタン */
  private showGameOver(score: number): void {
    // 既存のゲームオーバー表示をクリア（多重表示防止）
    for (const obj of this.gameOverGroup) obj.destroy();
    this.gameOverGroup = [];

    // 半透明オーバーレイ
    const overlay = this.add.graphics();
    overlay.fillStyle(0xfaf8ef, 0.7);
    const { width, height } = this.scale;
    overlay.fillRect(0, 0, width, height);
    this.gameOverGroup.push(overlay);

    const goText = this.add.text(240, 300, 'Game Over!', {
      fontSize: '42px',
      color: '#776e65',
      fontFamily: 'Arial, Helvetica, sans-serif',
      fontStyle: 'bold',
    }).setOrigin(0.5);
    this.gameOverGroup.push(goText);

    const scoreText = this.add.text(240, 360, \`Score: \${score}\`, {
      fontSize: '28px',
      color: '#776e65',
      fontFamily: 'Arial, sans-serif',
    }).setOrigin(0.5);
    this.gameOverGroup.push(scoreText);

    // リトライボタン
    const btnBg = this.add.graphics();
    btnBg.fillStyle(0x8f7a66, 1);
    btnBg.fillRoundedRect(170, 400, 140, 50, 6);
    btnBg.setInteractive(
      new Phaser.Geom.Rectangle(170, 400, 140, 50),
      Phaser.Geom.Rectangle.Contains
    );
    btnBg.on('pointerdown', () => this.restartGame());
    this.gameOverGroup.push(btnBg);

    const btnText = this.add.text(240, 425, 'Retry', {
      fontSize: '22px',
      color: '#f9f6f2',
      fontFamily: 'Arial, sans-serif',
      fontStyle: 'bold',
    }).setOrigin(0.5);
    this.gameOverGroup.push(btnText);
  }

  /** ゲームをリスタート */
  private restartGame(): void {
    // BGM 再開
    SoundManager.getInstance().startBGM();
    // GameScene を restart し、UIScene も restart してイベントリスナーを再登録
    this.scene.get('GameScene').scene.restart();
    this.scene.restart();
  }
}
`;

/** src/types/index.ts テンプレート（2048 用） */
export const PHASER_TYPES_INDEX = `/** 2048 で使う型定義 */
export type Direction = 'left' | 'right' | 'up' | 'down';
`;

/** CLAUDE.md テンプレート（Phaser プロジェクト用） */
export const PHASER_CLAUDE_MD = `# {{NAME}} - Phaser Game Project

DevRelay TestFlight で作成されたゲームプロジェクト。

## 技術スタック

- **Phaser 3** - HTML5 ゲームフレームワーク
- **TypeScript** - 型安全な開発
- **Vite** - HMR 対応ビルドツール
- **jsfxr** - プロシージャル効果音（音声ファイル不要）
- **Tone.js** - プロシージャル BGM（音声ファイル不要）

## ディレクトリ構成

- \`src/main.ts\` - Phaser.Game 初期化・設定
- \`src/scenes/\` - ゲームシーン（BootScene, GameScene, UIScene）
- \`src/utils/SoundManager.ts\` - BGM + SFX 管理（シングルトン）
- \`src/types/\` - 型定義
- \`public/assets/\` - 画像アセット（音声は不要）

## 開発サーバー

- \`pnpm dev\` で起動（HMR 対応、コード変更が即反映）
- URL: \`https://{{NAME}}.devrelay.io\`
- PM2 プロセス名: \`tf-{{NAME}}\`

## ゲーム開発ガイド

### シーン追加

1. \`src/scenes/\` に新しいシーンクラスを作成（\`Phaser.Scene\` 継承）
2. \`src/main.ts\` の \`scene\` 配列に追加

### アセット追加

1. ファイルを \`public/assets/\` に配置
2. \`BootScene.ts\` の \`preload()\` でロード

### ゲーム設定

- 画面サイズ: 480 x 720（モバイルファースト）
- スケールモード: \`Phaser.Scale.FIT\`（画面に合わせて拡縮）
- 背景色: \`#faf8ef\`（暖色系ベージュ）

### 現在のサンプル

2048 パズルゲーム:
- 4x4 グリッド、本家 2048 準拠の配色
- スワイプ（モバイル）+ 矢印キー（PC）で操作
- タイル合体 + スコア計算 + ゲームオーバー判定
- Retry ボタンでリスタート
- BGM（Tone.js チルなコード進行）+ SFX（jsfxr レトロ効果音）
- BGM/SFX 個別ミュートボタン

### よく使う改造パターン

- 「グリッドサイズ変えて」→ SIZE 定数を変更（5x5, 6x6 等）
- 「落ちものパズルにして」→ GameScene を自動落下型に変更
- 「マッチ3にして」→ タイル交換 + 3連マッチ判定に変更
- 「スネークゲームにして」→ タイマーベースの移動ロジックに変更
- 「ブロック崩しにして」→ パドル + ボール + ブロック衝突判定に変更
- 「BGM のムード変えて」→ SoundManager のコード進行を変更

See \`rules/devrelay.md\` for DevRelay rules.
`;

/** rules/project.md テンプレート（Phaser プロジェクト用） */
export const PHASER_PROJECT_RULES = `# Phaser Game Project Rules

## コーディング規約

- TypeScript strict モードで開発
- Phaser.Scene を継承してシーンを作成
- ゲームロジックとUI表示はシーンを分離する
- 型定義は \`src/types/\` に集約
- マジックナンバーは定数化する

## オーディオ

- 音声ファイルは使わない（jsfxr + Tone.js でプロシージャル生成）
- SoundManager シングルトンで一元管理
- iOS 対応: ユーザー操作後に AudioContext を初期化
- 全ゲームに BGM/SFX ミュートボタンを実装

## モバイル対応

- タッチ入力（スワイプ）を最優先で実装
- キーボード入力はフォールバックとして対応
- 画面サイズは 480x720 基準、Scale.FIT で自動調整
- ボタンやタイルは指で押しやすいサイズ（最低44px）

## パフォーマンス

- スプライトは可能な限り再利用（destroy/create を最小限に）
- 重い処理はフレーム分散を検討
- アセットは BootScene で一括プリロード
`;

/**
 * テンプレートファイルの定義マップ
 * パス → テンプレート内容
 */
export const PHASER_TEMPLATE_FILES: Record<string, string> = {
  'package.json': PHASER_PACKAGE_JSON,
  'vite.config.ts': PHASER_VITE_CONFIG,
  'tsconfig.json': PHASER_TSCONFIG,
  'index.html': PHASER_INDEX_HTML,
  'src/main.ts': PHASER_MAIN_TS,
  'src/scenes/BootScene.ts': PHASER_BOOT_SCENE,
  'src/scenes/GameScene.ts': PHASER_GAME_SCENE,
  'src/scenes/UIScene.ts': PHASER_UI_SCENE,
  'src/utils/SoundManager.ts': PHASER_SOUND_MANAGER,
  'src/types/index.ts': PHASER_TYPES_INDEX,
  'src/types/jsfxr.d.ts': PHASER_JSFXR_DTS,
  '.claude/skills/phaser-gamedev/SKILL.md': PHASER_SKILL_MD,
};
