/**
 * Phaser ゲームテンプレート定義
 *
 * testflight create --phaser で展開されるファイル群。
 * プレースホルダー: {{NAME}} → サービス名, {{PORT}} → ポート番号
 *
 * 棒消し（Nim）対戦ゲーム + BGM/SFX オーディオ対応。
 * マッチメイキング・CPU対戦・勝敗履歴の対戦基盤内蔵。
 */

import { PHASER_SKILL_MD } from './phaser-skill-template.js';

/** PHASER_SKILL_MD を re-export（testflight-manager から使えるように） */
export { PHASER_SKILL_MD };

/** package.json テンプレート（jsfxr + tone + ws + prisma 込み） */
export const PHASER_PACKAGE_JSON = `{
  "name": "{{NAME}}",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "postinstall": "prisma generate",
    "db:push": "prisma db push"
  },
  "dependencies": {
    "phaser": "^3.87.0",
    "jsfxr": "^1.2.2",
    "tone": "^15.0.0",
    "@prisma/client": "^6.0.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vite": "^6.0.0",
    "prisma": "^6.0.0",
    "@types/ws": "^8.5.0"
  }
}
`;

/** vite.config.ts テンプレート（WS プラグイン統合） */
export const PHASER_VITE_CONFIG = `import { defineConfig } from 'vite';
import { gameWsPlugin } from './server/vite-ws-plugin';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    allowedHosts: ['{{NAME}}.devrelay.io'],
  },
  plugins: [gameWsPlugin()],
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
  "include": ["src", "server"]
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
    body { background: #1a1a2e; overflow: hidden; }
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

/** src/main.ts テンプレート（対戦シーン追加） */
export const PHASER_MAIN_TS = `import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene';
import { LobbyScene } from './scenes/LobbyScene';
import { GameScene } from './scenes/GameScene';
import { UIScene } from './scenes/UIScene';
import { ResultScene } from './scenes/ResultScene';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game-container',
  width: 480,
  height: 720,
  backgroundColor: '#1a1a2e',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [BootScene, LobbyScene, GameScene, UIScene, ResultScene],
};

new Phaser.Game(config);
`;

/** src/scenes/BootScene.ts テンプレート（ロビーに遷移） */
export const PHASER_BOOT_SCENE = `import Phaser from 'phaser';

export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BootScene' });
  }

  create(): void {
    this.scene.start('LobbyScene');
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

  playVictory(): void {
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

/** src/scenes/GameScene.ts テンプレート（棒消し対戦 + SoundManager 統合） */
export const PHASER_GAME_SCENE = `import Phaser from 'phaser';
import { SoundManager } from '../utils/SoundManager';
import { GameClient } from '../net/GameClient';

/** 棒の描画設定 */
const STICK_WIDTH = 12;
const STICK_HEIGHT = 120;
const STICK_GAP = 18;
const STICK_Y = 300;

export class GameScene extends Phaser.Scene {
  private client!: GameClient;
  private soundManager!: SoundManager;
  private bgmStarted = false;

  private sticks = 21;
  private myTurn = false;
  private selectedCount = 0;
  private opponentNickname = '';
  private isCpu = false;
  private roomId = '';

  /** 棒のグラフィックス配列 */
  private stickGraphics: Phaser.GameObjects.Graphics[] = [];
  /** UI テキスト群 */
  private turnText!: Phaser.GameObjects.Text;
  private infoText!: Phaser.GameObjects.Text;
  private stickCountText!: Phaser.GameObjects.Text;
  private selectText!: Phaser.GameObjects.Text;

  constructor() {
    super({ key: 'GameScene' });
  }

  create(data: {
    roomId: string;
    opponent: { nickname: string; isCpu: boolean };
    yourTurn: boolean;
    gameState: { sticks: number };
    gameName: string;
  }): void {
    this.client = GameClient.getInstance();
    this.soundManager = SoundManager.getInstance();
    this.bgmStarted = false;

    this.roomId = data.roomId;
    this.opponentNickname = data.opponent.nickname;
    this.isCpu = data.opponent.isCpu;
    this.sticks = data.gameState.sticks;
    this.myTurn = data.yourTurn;
    this.selectedCount = 0;

    // UIScene を起動
    this.scene.launch('UIScene');

    // 対戦相手表示
    const vsLabel = this.isCpu ? 'vs CPU 🤖' : \`vs \${this.opponentNickname}\`;
    this.add.text(240, 30, vsLabel, {
      fontSize: '22px',
      color: '#aaaacc',
      fontFamily: 'Arial, sans-serif',
      fontStyle: 'bold',
    }).setOrigin(0.5);

    // ターン表示
    this.turnText = this.add.text(240, 70, '', {
      fontSize: '24px',
      color: '#ffcc00',
      fontFamily: 'Arial, sans-serif',
      fontStyle: 'bold',
    }).setOrigin(0.5);

    // 残り棒数
    this.stickCountText = this.add.text(240, 220, '', {
      fontSize: '28px',
      color: '#e0e0ff',
      fontFamily: 'Arial, sans-serif',
      fontStyle: 'bold',
    }).setOrigin(0.5);

    // 選択数表示
    this.selectText = this.add.text(240, 460, '', {
      fontSize: '20px',
      color: '#aaaacc',
      fontFamily: 'Arial, sans-serif',
    }).setOrigin(0.5);

    // 操作説明
    this.infoText = this.add.text(240, 500, '', {
      fontSize: '16px',
      color: '#6666aa',
      fontFamily: 'Arial, sans-serif',
      align: 'center',
    }).setOrigin(0.5);

    // 取るボタン（1, 2, 3）
    [1, 2, 3].forEach((n, i) => {
      this.createTakeButton(120 + i * 120, 560, n);
    });

    // 降参ボタン
    this.createSmallButton(240, 640, '🏳️ 降参', '#664444', () => {
      this.client.send({ type: 'forfeit' });
    });

    // WS イベント
    this.client.on('state', (msg: any) => {
      this.sticks = msg.gameState.sticks;
      this.myTurn = msg.yourTurn;
      this.selectedCount = 0;
      this.drawSticks();
      this.updateUI();
      this.soundManager.playMove();
    });

    this.client.on('result', (msg: any) => {
      this.soundManager.stopBGM();
      if (msg.winner === 'you') {
        this.soundManager.playVictory();
      } else {
        this.soundManager.playGameOver();
      }
      this.scene.stop('UIScene');
      this.scene.start('ResultScene', {
        winner: msg.winner,
        stats: msg.stats,
        opponentNickname: this.opponentNickname,
        isCpu: this.isCpu,
      });
    });

    this.client.on('opponent_left', () => {
      this.scene.stop('UIScene');
      this.scene.start('ResultScene', {
        winner: 'you',
        stats: null,
        opponentNickname: this.opponentNickname,
        isCpu: this.isCpu,
      });
    });

    // キーボード入力（1, 2, 3 キー）
    if (this.input.keyboard) {
      this.input.keyboard.on('keydown', (e: KeyboardEvent) => {
        this.tryStartBGM();
        const n = parseInt(e.key);
        if (n >= 1 && n <= 3) this.takeTurn(n);
      });
    }

    this.drawSticks();
    this.updateUI();
  }

  /** 初回操作で BGM を開始 */
  private tryStartBGM(): void {
    if (this.bgmStarted) return;
    this.bgmStarted = true;
    this.soundManager.startBGM();
  }

  /** 「n本取る」ボタンを作成 */
  private createTakeButton(x: number, y: number, count: number): void {
    const bg = this.add.graphics();
    bg.fillStyle(0x4444aa, 1);
    bg.fillRoundedRect(x - 45, y - 25, 90, 50, 8);
    bg.setInteractive(
      new Phaser.Geom.Rectangle(x - 45, y - 25, 90, 50),
      Phaser.Geom.Rectangle.Contains
    );
    bg.on('pointerdown', () => {
      this.tryStartBGM();
      this.takeTurn(count);
    });

    this.add.text(x, y, \`\${count}本取る\`, {
      fontSize: '18px',
      color: '#ffffff',
      fontFamily: 'Arial, sans-serif',
      fontStyle: 'bold',
    }).setOrigin(0.5);
  }

  /** 小さいボタンを作成 */
  private createSmallButton(x: number, y: number, label: string, color: string, onClick: () => void): void {
    const bg = this.add.graphics();
    bg.fillStyle(parseInt(color.replace('#', ''), 16), 1);
    bg.fillRoundedRect(x - 60, y - 18, 120, 36, 6);
    bg.setInteractive(
      new Phaser.Geom.Rectangle(x - 60, y - 18, 120, 36),
      Phaser.Geom.Rectangle.Contains
    );
    bg.on('pointerdown', onClick);

    this.add.text(x, y, label, {
      fontSize: '14px',
      color: '#ffffff',
      fontFamily: 'Arial, sans-serif',
    }).setOrigin(0.5);
  }

  /** ターンを実行 */
  private takeTurn(count: number): void {
    if (!this.myTurn) return;
    if (count < 1 || count > 3 || count > this.sticks) return;
    this.client.send({ type: 'move', action: { take: count } });
    this.myTurn = false;
    this.updateUI();
  }

  /** 棒を描画 */
  private drawSticks(): void {
    // 既存の棒グラフィックスを削除
    this.stickGraphics.forEach(g => g.destroy());
    this.stickGraphics = [];

    const totalWidth = this.sticks * STICK_WIDTH + (this.sticks - 1) * STICK_GAP;
    const startX = (480 - totalWidth) / 2;

    for (let i = 0; i < this.sticks; i++) {
      const x = startX + i * (STICK_WIDTH + STICK_GAP);
      const g = this.add.graphics();
      // 棒の色: グラデーション風に交互
      const color = i % 2 === 0 ? 0xccaa44 : 0xddbb55;
      g.fillStyle(color, 1);
      g.fillRoundedRect(x, STICK_Y, STICK_WIDTH, STICK_HEIGHT, 3);
      this.stickGraphics.push(g);
    }

    this.stickCountText.setText(\`残り \${this.sticks} 本\`);
  }

  /** UI 更新 */
  private updateUI(): void {
    if (this.myTurn) {
      this.turnText.setText('🎯 あなたの番');
      this.turnText.setColor('#44ff44');
      this.infoText.setText('1〜3本取ってください（最後を取ったら負け）');
    } else {
      this.turnText.setText('⏳ 相手の番...');
      this.turnText.setColor('#ffcc00');
      this.infoText.setText('相手が考えています...');
    }
  }

  shutdown(): void {
    this.client.off('state', () => {});
    this.client.off('result', () => {});
    this.client.off('opponent_left', () => {});
  }
}
`;

/** src/scenes/UIScene.ts テンプレート（BGM/SFX ミュートボタン） */
export const PHASER_UI_SCENE = `import Phaser from 'phaser';
import { SoundManager } from '../utils/SoundManager';

/**
 * UI オーバーレイシーン: BGM/SFX ミュートボタン
 * GameScene の上にパラレル起動される
 */
export class UIScene extends Phaser.Scene {
  private bgmBtn!: Phaser.GameObjects.Text;
  private sfxBtn!: Phaser.GameObjects.Text;

  constructor() {
    super({ key: 'UIScene' });
  }

  create(): void {
    const sm = SoundManager.getInstance();

    const btnStyle = {
      fontSize: '14px',
      color: '#e0e0ff',
      fontFamily: 'Arial, sans-serif',
      fontStyle: 'bold',
      backgroundColor: '#333355',
      padding: { x: 6, y: 4 },
    };

    // BGM ミュートボタン（右上）
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
  }
}
`;

/** src/types/index.ts テンプレート */
export const PHASER_TYPES_INDEX = `/** ゲーム共通型定義 */

/** サーバーメッセージの基本型 */
export interface ServerMsg {
  type: string;
  [key: string]: any;
}
`;

/** CLAUDE.md テンプレート（Phaser プロジェクト用 + 対戦基盤） */
export const PHASER_CLAUDE_MD = `# {{NAME}} - Phaser Game Project

DevRelay TestFlight で作成されたゲームプロジェクト（対戦基盤付き）。

## 技術スタック

- **Phaser 3** - HTML5 ゲームフレームワーク
- **TypeScript** - 型安全な開発
- **Vite** - HMR 対応ビルドツール + WebSocket サーバー（同一ポート）
- **jsfxr** - プロシージャル効果音（音声ファイル不要）
- **Tone.js** - プロシージャル BGM（音声ファイル不要）
- **Prisma** - PostgreSQL ORM（対戦履歴保存）
- **ws** - WebSocket サーバー（対戦通信）

## ディレクトリ構成

- \`src/main.ts\` - Phaser.Game 初期化・設定
- \`src/scenes/\` - ゲームシーン（Boot, Lobby, Game, UI, Result）
- \`src/net/GameClient.ts\` - WebSocket クライアント（シングルトン）
- \`src/net/protocol.ts\` - メッセージプロトコル型定義
- \`src/utils/SoundManager.ts\` - BGM + SFX 管理（シングルトン）
- \`server/\` - 対戦サーバー（Vite プラグインとして動作）
  - \`vite-ws-plugin.ts\` - Vite に WS を接続
  - \`ws-server.ts\` - 接続管理・メッセージルーティング
  - \`matchmaker.ts\` - マッチメイキング（10秒待機 → CPU フォールバック）
  - \`room.ts\` - ゲームルーム（ターン管理・勝敗判定）
  - \`cpu-player.ts\` - CPU の手を遅延実行
  - \`game-adapter.ts\` - GameAdapter インターフェース
  - \`adapters/\` - ゲーム固有ロジック（差し替え可能）
- \`prisma/schema.prisma\` - DB スキーマ（Player, Match）
- \`public/assets/\` - 画像アセット（音声は不要）

## 開発サーバー

- \`pnpm dev\` で起動（HMR + WebSocket 対応）
- URL: \`https://{{NAME}}.devrelay.io\`
- PM2 プロセス名: \`tf-{{NAME}}\`

## 対戦アーキテクチャ

### GameAdapter パターン

ゲーム固有ロジックは \`server/adapters/\` に実装し、\`server/adapters/index.ts\` で切り替える。
インターフェース（\`server/game-adapter.ts\`）:
- \`createInitialState()\` — 初期盤面を生成
- \`applyMove(state, player, action)\` — 手を適用、勝敗判定
- \`getCpuMove(state, cpuPlayer)\` — CPU の手を決定
- \`getPlayerView(state, player)\` — プレイヤーに見せる状態（不完全情報対応）

### マッチメイキング
1. LobbyScene でニックネーム入力 → \`join\` 送信
2. 10秒以内にもう1人来ればPvP、来なければCPU戦
3. ターン制で交互にプレイ
4. 勝敗を DB に記録（連勝も追跡）

### ゲームを変更する手順
1. \`server/adapters/\` に新しいアダプタを作成（GameAdapter を実装）
2. \`server/adapters/index.ts\` の export を差し替え
3. \`src/scenes/GameScene.ts\` の描画・入力を新ゲームに合わせて変更
4. \`src/scenes/LobbyScene.ts\` のルール説明テキストを更新

### 現在のサンプル

棒消し（Nim）対戦ゲーム:
- 21本の棒から交互に1〜3本取る
- 最後の1本を取ったら負け
- 10秒マッチメイキング → CPU フォールバック
- 勝敗履歴 + 連勝追跡

### よく使う改造パターン

- 「じゃんけんにして」→ RPS アダプタ作成 + GameScene を変更
- 「オセロにして」→ ボード型アダプタ + グリッド描画に変更
- 「マッチメイキング時間変えて」→ matchmaker.ts の MATCH_TIMEOUT_MS を変更
- 「CPU を強くして」→ アダプタの getCpuMove() を改善
- 「BGM のムード変えて」→ SoundManager のコード進行を変更

See \`rules/devrelay.md\` for DevRelay rules.
`;

/** rules/project.md テンプレート（Phaser プロジェクト用 + 対戦基盤） */
export const PHASER_PROJECT_RULES = `# Phaser Game Project Rules

## コーディング規約

- TypeScript strict モードで開発
- Phaser.Scene を継承してシーンを作成
- ゲームロジックとUI表示はシーンを分離する
- 型定義は \`src/types/\` に集約
- マジックナンバーは定数化する

## 対戦基盤

- ゲーム固有ロジックは GameAdapter インターフェースで抽象化する
- GameAdapter 実装は \`server/adapters/\` に配置
- 対戦の状態管理はサーバー側（server/room.ts）が権威を持つ
- クライアントは描画と入力の送信のみ担当（サーバー権威型）
- CPU の手は 500〜1500ms の遅延で実行（人間らしさ）

## オーディオ

- 音声ファイルは使わない（jsfxr + Tone.js でプロシージャル生成）
- SoundManager シングルトンで一元管理
- iOS 対応: ユーザー操作後に AudioContext を初期化
- 全ゲームに BGM/SFX ミュートボタンを実装

## モバイル対応

- タッチ入力を最優先で実装
- キーボード入力はフォールバックとして対応
- 画面サイズは 480x720 基準、Scale.FIT で自動調整
- ボタンやタイルは指で押しやすいサイズ（最低44px）

## パフォーマンス

- スプライトは可能な限り再利用（destroy/create を最小限に）
- 重い処理はフレーム分散を検討
- アセットは BootScene で一括プリロード
`;

/* ==============================================================
 *  対戦基盤（Multiplayer Infrastructure）テンプレート
 * ============================================================== */

/** prisma/schema.prisma テンプレート（Player + Match モデル） */
export const PHASER_PRISMA_SCHEMA = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

/// プレイヤー（ニックネームで識別、簡易認証なし）
model Player {
  id         String   @id @default(uuid())
  nickname   String   @unique
  wins       Int      @default(0)
  losses     Int      @default(0)
  draws      Int      @default(0)
  streak     Int      @default(0)
  bestStreak Int      @default(0)
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  matchesAsP1 Match[] @relation("player1")
  matchesAsP2 Match[] @relation("player2")
}

/// 対戦履歴
model Match {
  id         String   @id @default(uuid())
  player1Id  String
  player2Id  String?
  winnerId   String?
  isCpuMatch Boolean  @default(false)
  turns      Int      @default(0)
  duration   Int      @default(0)
  createdAt  DateTime @default(now())

  player1 Player  @relation("player1", fields: [player1Id], references: [id])
  player2 Player? @relation("player2", fields: [player2Id], references: [id])
}
`;

/** server/game-adapter.ts — ゲームアダプタインターフェース */
export const PHASER_GAME_ADAPTER = `/**
 * ゲームアダプタインターフェース
 *
 * 対戦基盤はゲーム固有ロジックをこのインターフェース経由で呼び出す。
 * 新しいゲームを作る場合は adapters/ に実装して index.ts で切り替える。
 */

/** ゲーム状態（ゲーム固有の形状） */
export interface GameState {
  [key: string]: any;
}

/** 手の適用結果 */
export interface MoveResult {
  /** 有効な手だったか */
  valid: boolean;
  /** 適用後の新しい状態 */
  newState: GameState;
  /** ゲーム終了か */
  gameOver: boolean;
  /** 勝者（gameOver 時のみ） */
  winner?: 'player1' | 'player2' | 'draw';
}

/** ゲームアダプタ: ゲーム固有ロジックの抽象化 */
export interface GameAdapter {
  /** ゲーム名（ログ・表示用） */
  name: string;

  /** 初期状態を生成 */
  createInitialState(): GameState;

  /** 手の有効性を検証し、新しい状態を返す */
  applyMove(state: GameState, player: 'player1' | 'player2', action: any): MoveResult;

  /** CPU の手を決定 */
  getCpuMove(state: GameState, cpuPlayer: 'player1' | 'player2'): any;

  /** プレイヤーに見せる状態を生成（不完全情報ゲーム用） */
  getPlayerView(state: GameState, player: 'player1' | 'player2'): GameState;
}
`;

/** server/adapters/nim-adapter.ts — 棒消し（Nim）ゲームのサンプルアダプタ */
export const PHASER_NIM_ADAPTER = `import type { GameAdapter, GameState, MoveResult } from '../game-adapter';

/**
 * 棒消し（Nim）ゲームアダプタ
 *
 * ルール:
 * - 21 本の棒がある
 * - 交互に 1〜3 本取る
 * - 最後の 1 本を取った方が負け
 */
export class NimAdapter implements GameAdapter {
  name = 'nim';

  createInitialState(): GameState {
    return { sticks: 21 };
  }

  applyMove(state: GameState, player: 'player1' | 'player2', action: any): MoveResult {
    const take = Number(action?.take);
    // バリデーション: 1〜3 本、かつ残り本数以下
    if (!Number.isInteger(take) || take < 1 || take > 3 || take > state.sticks) {
      return { valid: false, newState: state, gameOver: false };
    }

    const remaining = state.sticks - take;
    const newState = { sticks: remaining };

    // 最後の 1 本を取ったら負け
    if (remaining === 0) {
      const winner = player === 'player1' ? 'player2' : 'player1';
      return { valid: true, newState, gameOver: true, winner };
    }

    return { valid: true, newState, gameOver: false };
  }

  getCpuMove(state: GameState, _cpuPlayer: 'player1' | 'player2'): any {
    // 最適戦略: (残り - 1) % 4 === 0 の状態に持ち込む
    const optimal = (state.sticks - 1) % 4;
    if (optimal >= 1 && optimal <= 3) {
      return { take: optimal };
    }
    // 最適手がない場合はランダム（1〜min(3, 残り)）
    const max = Math.min(3, state.sticks);
    return { take: Math.floor(Math.random() * max) + 1 };
  }

  getPlayerView(state: GameState, _player: 'player1' | 'player2'): GameState {
    // 完全情報ゲームなのでそのまま返す
    return { ...state };
  }
}
`;

/** server/adapters/index.ts — アクティブなアダプタを export */
export const PHASER_ADAPTER_INDEX = `/**
 * アクティブなゲームアダプタ
 *
 * ゲームを変更する場合はここの import/export を差し替える。
 */
import { NimAdapter } from './nim-adapter';

export const gameAdapter = new NimAdapter();
`;

/** server/db.ts — Prisma クライアントの初期化 */
export const PHASER_DB = `import { PrismaClient } from '@prisma/client';

/**
 * Prisma クライアント（シングルトン）
 * Vite の dev サーバープロセス内で使用
 */
export const prisma = new PrismaClient();
`;

/** server/ws-server.ts — WebSocket 接続管理とメッセージルーティング */
export const PHASER_WS_SERVER = `import type { WebSocket } from 'ws';
import { matchmaker } from './matchmaker';

/** 接続中のクライアント情報 */
interface Client {
  ws: WebSocket;
  nickname: string;
  roomId: string | null;
}

/** 全接続クライアント */
const clients = new Map<WebSocket, Client>();

/**
 * 新しい WebSocket 接続を処理
 */
export function handleConnection(ws: WebSocket): void {
  const client: Client = { ws, nickname: '', roomId: null };
  clients.set(ws, client);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      handleMessage(client, msg);
    } catch {
      send(ws, { type: 'error', message: '不正なメッセージ形式' });
    }
  });

  ws.on('close', () => {
    // マッチメイキングキューから除去
    matchmaker.leave(client);
    // ルーム内なら相手に通知
    if (client.roomId) {
      matchmaker.handleDisconnect(client);
    }
    clients.delete(ws);
  });
}

/** メッセージハンドラ */
function handleMessage(client: Client, msg: any): void {
  switch (msg.type) {
    case 'join':
      client.nickname = String(msg.nickname || 'Guest').slice(0, 20);
      matchmaker.join(client);
      break;
    case 'move':
      if (client.roomId) {
        matchmaker.handleMove(client, msg.action);
      }
      break;
    case 'forfeit':
      if (client.roomId) {
        matchmaker.handleForfeit(client);
      }
      break;
    case 'rematch':
      if (client.roomId) {
        matchmaker.handleRematch(client);
      }
      break;
    case 'leave':
      matchmaker.leave(client);
      break;
    default:
      send(client.ws, { type: 'error', message: '不明なメッセージタイプ' });
  }
}

/** JSON メッセージを送信 */
export function send(ws: WebSocket, data: any): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}
`;

/** server/matchmaker.ts — ロビーキュー + マッチング + ルーム管理 */
export const PHASER_MATCHMAKER = `import { send } from './ws-server';
import { Room } from './room';

/** クライアント型（ws-server から） */
interface Client {
  ws: import('ws').WebSocket;
  nickname: string;
  roomId: string | null;
}

/** マッチメイキング待ちのキュー */
const queue: Client[] = [];
/** アクティブなルーム */
const rooms = new Map<string, Room>();
/** CPU マッチング用タイマー */
const timers = new Map<Client, ReturnType<typeof setTimeout>>();

/** マッチメイキングのタイムアウト（ミリ秒） */
const MATCH_TIMEOUT_MS = 10_000;

/**
 * マッチメイカー: ロビー管理とルーム生成
 */
export const matchmaker = {
  /** ロビーに参加 */
  join(client: Client): void {
    // 既にキューにいたら除去
    this.removeFromQueue(client);

    // キューに他のプレイヤーがいれば即マッチ
    if (queue.length > 0) {
      const opponent = queue.shift()!;
      // タイマーをクリア
      const timer = timers.get(opponent);
      if (timer) {
        clearTimeout(timer);
        timers.delete(opponent);
      }
      this.createRoom(opponent, client);
      return;
    }

    // キューに追加して待機
    queue.push(client);
    send(client.ws, { type: 'waiting', position: 1 });

    // 10秒後に CPU 戦開始
    const timer = setTimeout(() => {
      timers.delete(client);
      this.removeFromQueue(client);
      this.createRoom(client, null); // null = CPU
    }, MATCH_TIMEOUT_MS);
    timers.set(client, timer);
  },

  /** キューから除去 */
  removeFromQueue(client: Client): void {
    const idx = queue.indexOf(client);
    if (idx !== -1) queue.splice(idx, 1);
    const timer = timers.get(client);
    if (timer) {
      clearTimeout(timer);
      timers.delete(client);
    }
  },

  /** ロビー・ルームから離脱 */
  leave(client: Client): void {
    this.removeFromQueue(client);
    if (client.roomId) {
      const room = rooms.get(client.roomId);
      if (room) {
        room.handleForfeit(client);
        rooms.delete(client.roomId);
      }
      client.roomId = null;
    }
  },

  /** ルームを作成してゲーム開始 */
  createRoom(player1: Client, player2: Client | null): void {
    const roomId = \`room_\${Date.now()}_\${Math.random().toString(36).slice(2, 8)}\`;
    const room = new Room(roomId, player1, player2);
    rooms.set(roomId, room);
    player1.roomId = roomId;
    if (player2) player2.roomId = roomId;
    room.start();
  },

  /** プレイヤーの手を処理 */
  handleMove(client: Client, action: any): void {
    const room = client.roomId ? rooms.get(client.roomId) : null;
    if (room) room.handleMove(client, action);
  },

  /** 降参を処理 */
  handleForfeit(client: Client): void {
    const room = client.roomId ? rooms.get(client.roomId) : null;
    if (room) {
      room.handleForfeit(client);
      rooms.delete(client.roomId!);
      client.roomId = null;
    }
  },

  /** 切断を処理 */
  handleDisconnect(client: Client): void {
    const room = client.roomId ? rooms.get(client.roomId) : null;
    if (room) {
      room.handleDisconnect(client);
      rooms.delete(client.roomId!);
    }
    client.roomId = null;
  },

  /** リマッチ要求を処理 */
  handleRematch(client: Client): void {
    const room = client.roomId ? rooms.get(client.roomId) : null;
    if (room) {
      const shouldRestart = room.handleRematch(client);
      if (shouldRestart) {
        room.start();
      }
    }
  },

  /** リアルタイム統計を取得（管理画面用） */
  getStats(): { online: number; inQueue: number; inGame: number; activeRooms: number } {
    const inQueue = queue.length;
    const activeRooms = rooms.size;
    // ルームごとに2人（CPU含む）、キューにいる人数を加算
    let inGame = 0;
    for (const room of rooms.values()) {
      inGame += 2; // player1 + player2(or CPU)
    }
    return { online: inQueue + inGame, inQueue, inGame, activeRooms };
  },
};
`;

/** server/room.ts — ゲームルーム（2プレイヤー、ターン管理） */
export const PHASER_ROOM = `import { send } from './ws-server';
import { gameAdapter } from './adapters/index';
import { scheduleCpuMove } from './cpu-player';
import { prisma } from './db';
import type { GameState } from './game-adapter';

/** クライアント型 */
interface Client {
  ws: import('ws').WebSocket;
  nickname: string;
  roomId: string | null;
}

/**
 * ゲームルーム: 2プレイヤー間のターン制対戦を管理
 */
export class Room {
  private state: GameState = {};
  private currentTurn: 'player1' | 'player2' = 'player1';
  private turnCount = 0;
  private startTime = Date.now();
  private gameOver = false;
  private player1RematchReady = false;
  private player2RematchReady = false;
  private cpuTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    public readonly roomId: string,
    private player1: Client,
    private player2: Client | null, // null = CPU
  ) {}

  /** CPU 対戦かどうか */
  get isCpu(): boolean {
    return this.player2 === null;
  }

  /** ゲーム開始 */
  start(): void {
    this.state = gameAdapter.createInitialState();
    this.currentTurn = Math.random() < 0.5 ? 'player1' : 'player2';
    this.turnCount = 0;
    this.startTime = Date.now();
    this.gameOver = false;
    this.player1RematchReady = false;
    this.player2RematchReady = false;

    const baseMsg = {
      type: 'matched' as const,
      roomId: this.roomId,
      gameName: gameAdapter.name,
    };

    // Player1 に通知
    send(this.player1.ws, {
      ...baseMsg,
      opponent: {
        nickname: this.isCpu ? 'CPU' : this.player2!.nickname,
        isCpu: this.isCpu,
      },
      yourTurn: this.currentTurn === 'player1',
      gameState: gameAdapter.getPlayerView(this.state, 'player1'),
    });

    // Player2 に通知（人間の場合）
    if (this.player2) {
      send(this.player2.ws, {
        ...baseMsg,
        opponent: {
          nickname: this.player1.nickname,
          isCpu: false,
        },
        yourTurn: this.currentTurn === 'player2',
        gameState: gameAdapter.getPlayerView(this.state, 'player2'),
      });
    }

    // CPU の番なら自動で手を打つ
    if (this.isCpu && this.currentTurn === 'player2') {
      this.scheduleCpuTurn();
    }
  }

  /** プレイヤーの手を処理 */
  handleMove(client: Client, action: any): void {
    if (this.gameOver) return;

    const player = client === this.player1 ? 'player1' : 'player2';
    if (player !== this.currentTurn) {
      send(client.ws, { type: 'error', message: 'あなたの番ではありません' });
      return;
    }

    const result = gameAdapter.applyMove(this.state, player, action);
    if (!result.valid) {
      send(client.ws, { type: 'error', message: '無効な手です' });
      return;
    }

    this.state = result.newState;
    this.turnCount++;

    if (result.gameOver) {
      this.endGame(result.winner || 'draw');
      return;
    }

    // ターン切り替え
    this.currentTurn = this.currentTurn === 'player1' ? 'player2' : 'player1';
    this.broadcastState();

    // CPU の番なら自動で手を打つ
    if (this.isCpu && this.currentTurn === 'player2') {
      this.scheduleCpuTurn();
    }
  }

  /** CPU のターンをスケジュール */
  private scheduleCpuTurn(): void {
    this.cpuTimer = scheduleCpuMove(this.state, 'player2', (action) => {
      if (this.gameOver) return;
      const result = gameAdapter.applyMove(this.state, 'player2', action);
      if (result.valid) {
        this.state = result.newState;
        this.turnCount++;
        if (result.gameOver) {
          this.endGame(result.winner || 'draw');
        } else {
          this.currentTurn = 'player1';
          this.broadcastState();
        }
      }
    });
  }

  /** 状態を両プレイヤーにブロードキャスト */
  private broadcastState(): void {
    send(this.player1.ws, {
      type: 'state',
      gameState: gameAdapter.getPlayerView(this.state, 'player1'),
      yourTurn: this.currentTurn === 'player1',
    });
    if (this.player2) {
      send(this.player2.ws, {
        type: 'state',
        gameState: gameAdapter.getPlayerView(this.state, 'player2'),
        yourTurn: this.currentTurn === 'player2',
      });
    }
  }

  /** ゲーム終了処理 */
  private async endGame(winner: 'player1' | 'player2' | 'draw'): Promise<void> {
    this.gameOver = true;
    if (this.cpuTimer) clearTimeout(this.cpuTimer);

    const duration = Math.floor((Date.now() - this.startTime) / 1000);

    // DB にプレイヤーと結果を保存
    try {
      const p1 = await prisma.player.upsert({
        where: { nickname: this.player1.nickname },
        create: { nickname: this.player1.nickname },
        update: {},
      });

      let p2Id: string | null = null;
      if (this.player2) {
        const p2 = await prisma.player.upsert({
          where: { nickname: this.player2.nickname },
          create: { nickname: this.player2.nickname },
          update: {},
        });
        p2Id = p2.id;
      }

      // 勝者 ID を決定
      let winnerId: string | null = null;
      if (winner === 'player1') winnerId = p1.id;
      else if (winner === 'player2' && p2Id) winnerId = p2Id;

      // Match レコード作成
      await prisma.match.create({
        data: {
          player1Id: p1.id,
          player2Id: p2Id,
          winnerId,
          isCpuMatch: this.isCpu,
          turns: this.turnCount,
          duration,
        },
      });

      // プレイヤー統計を更新
      if (winner === 'player1') {
        const newStreak = p1.streak + 1;
        await prisma.player.update({
          where: { id: p1.id },
          data: {
            wins: { increment: 1 },
            streak: newStreak,
            bestStreak: Math.max(newStreak, p1.bestStreak),
          },
        });
        if (p2Id) {
          await prisma.player.update({
            where: { id: p2Id },
            data: { losses: { increment: 1 }, streak: 0 },
          });
        }
      } else if (winner === 'player2') {
        await prisma.player.update({
          where: { id: p1.id },
          data: { losses: { increment: 1 }, streak: 0 },
        });
        if (p2Id) {
          const p2Data = await prisma.player.findUnique({ where: { id: p2Id } });
          if (p2Data) {
            const newStreak = p2Data.streak + 1;
            await prisma.player.update({
              where: { id: p2Id },
              data: {
                wins: { increment: 1 },
                streak: newStreak,
                bestStreak: Math.max(newStreak, p2Data.bestStreak),
              },
            });
          }
        }
      } else {
        // draw
        await prisma.player.update({
          where: { id: p1.id },
          data: { draws: { increment: 1 }, streak: 0 },
        });
        if (p2Id) {
          await prisma.player.update({
            where: { id: p2Id },
            data: { draws: { increment: 1 }, streak: 0 },
          });
        }
      }

      // 最新統計を取得して結果を送信
      const p1Stats = await prisma.player.findUnique({ where: { id: p1.id } });
      this.sendResult(this.player1, winner === 'player1' ? 'you' : winner === 'player2' ? 'opponent' : 'draw', p1Stats);

      if (this.player2 && p2Id) {
        const p2Stats = await prisma.player.findUnique({ where: { id: p2Id } });
        this.sendResult(this.player2, winner === 'player2' ? 'you' : winner === 'player1' ? 'opponent' : 'draw', p2Stats);
      }
    } catch (err) {
      console.error('対戦結果の保存に失敗:', err);
      // DB エラーでもゲーム結果は通知
      this.sendResult(this.player1, winner === 'player1' ? 'you' : winner === 'player2' ? 'opponent' : 'draw', null);
      if (this.player2) {
        this.sendResult(this.player2, winner === 'player2' ? 'you' : winner === 'player1' ? 'opponent' : 'draw', null);
      }
    }
  }

  /** 結果メッセージを送信 */
  private sendResult(client: Client, result: 'you' | 'opponent' | 'draw', stats: any): void {
    send(client.ws, {
      type: 'result',
      winner: result,
      stats: stats ? {
        wins: stats.wins,
        losses: stats.losses,
        draws: stats.draws,
        streak: stats.streak,
        bestStreak: stats.bestStreak,
      } : null,
    });
  }

  /** 降参処理 */
  handleForfeit(client: Client): void {
    if (this.gameOver) return;
    const winner = client === this.player1 ? 'player2' : 'player1';
    this.endGame(winner);
  }

  /** 切断処理 */
  handleDisconnect(client: Client): void {
    if (this.cpuTimer) clearTimeout(this.cpuTimer);
    if (this.gameOver) return;
    // 残っているプレイヤーに通知
    const other = client === this.player1 ? this.player2 : this.player1;
    if (other) {
      send(other.ws, { type: 'opponent_left' });
      other.roomId = null;
    }
    // 切断側の負けとして記録
    const winner = client === this.player1 ? 'player2' : 'player1';
    this.endGame(winner);
  }

  /** リマッチ要求を処理（両者 ready ならリスタート） */
  handleRematch(client: Client): boolean {
    if (client === this.player1) this.player1RematchReady = true;
    else this.player2RematchReady = true;

    // CPU 対戦は即リマッチ
    if (this.isCpu && this.player1RematchReady) return true;

    // 両者 ready でリスタート
    if (this.player1RematchReady && this.player2RematchReady) return true;

    // 相手にリマッチ要求を通知
    const other = client === this.player1 ? this.player2 : this.player1;
    if (other) {
      send(other.ws, { type: 'rematch_request', from: client.nickname });
    }
    return false;
  }
}
`;

/** server/cpu-player.ts — CPU プレイヤーの手をスケジュール */
export const PHASER_CPU_PLAYER = `import { gameAdapter } from './adapters/index';
import type { GameState } from './game-adapter';

/** CPU 思考の最小・最大遅延（ms） */
const CPU_DELAY_MIN = 500;
const CPU_DELAY_MAX = 1500;

/**
 * CPU の手を遅延実行でスケジュール
 * @returns タイマー ID（キャンセル用）
 */
export function scheduleCpuMove(
  state: GameState,
  cpuPlayer: 'player1' | 'player2',
  callback: (action: any) => void,
): ReturnType<typeof setTimeout> {
  const delay = CPU_DELAY_MIN + Math.random() * (CPU_DELAY_MAX - CPU_DELAY_MIN);
  return setTimeout(() => {
    const action = gameAdapter.getCpuMove(state, cpuPlayer);
    callback(action);
  }, delay);
}
`;

/** server/vite-ws-plugin.ts — Vite プラグイン: dev サーバーに WS をアタッチ */
export const PHASER_WS_PLUGIN = `import type { Plugin } from 'vite';
import { WebSocketServer } from 'ws';
import { handleConnection } from './ws-server';
import { getStats, getStatsHtml } from './stats-api';

/**
 * Vite プラグイン: dev サーバーに WebSocket + 管理画面 API を追加
 * - /ws — ゲーム用 WebSocket
 * - /api/stats — 統計 JSON API
 * - /stats — 管理画面 HTML
 */
export function gameWsPlugin(): Plugin {
  return {
    name: 'game-ws',
    configureServer(server) {
      if (!server.httpServer) return;

      // 管理画面 API（/api/stats）
      server.middlewares.use('/api/stats', async (_req, res) => {
        try {
          const stats = await getStats();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(stats));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'Failed to fetch stats' }));
        }
      });

      // 管理画面 HTML（/stats）
      server.middlewares.use('/stats', (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(getStatsHtml());
      });

      // WebSocket サーバー（noServer モード: Vite HMR の WS と衝突しないよう手動ルーティング）
      const wss = new WebSocketServer({ noServer: true });
      wss.on('connection', handleConnection);
      server.httpServer.on('upgrade', (req, socket, head) => {
        const pathname = new URL(req.url || '', 'http://localhost').pathname;
        if (pathname === '/ws') {
          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
          });
        }
        // /ws 以外（Vite HMR 等）はデフォルト処理に任せる
      });
      console.log('🎮 Game server attached: WS(/ws) + Stats(/stats)');
    },
  };
}
`;

/** server/stats-api.ts — 統計データ取得（管理画面用） */
export const PHASER_STATS_API = `import { prisma } from './db';
import { matchmaker } from './matchmaker';

/**
 * 統計データを集計して返す（/api/stats エンドポイント用）
 */
export async function getStats() {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // リアルタイム統計
  const realtime = matchmaker.getStats();

  // 対戦統計（並列クエリ）
  const [total, today, week, month, todayCpu, todayPvp] = await Promise.all([
    prisma.match.count(),
    prisma.match.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.match.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.match.count({ where: { createdAt: { gte: monthAgo } } }),
    prisma.match.count({ where: { createdAt: { gte: todayStart }, isCpuMatch: true } }),
    prisma.match.count({ where: { createdAt: { gte: todayStart }, isCpuMatch: false } }),
  ]);

  // プレイヤー統計
  const [totalPlayers, active24h] = await Promise.all([
    prisma.player.count(),
    prisma.player.count({ where: { updatedAt: { gte: dayAgo } } }),
  ]);

  // ランキング TOP10（勝利数順）
  const leaderboard = await prisma.player.findMany({
    orderBy: { wins: 'desc' },
    take: 10,
    select: { nickname: true, wins: true, losses: true, draws: true, streak: true, bestStreak: true },
  });

  return {
    realtime,
    matches: { today, week, month, total, todayCpu, todayPvp },
    players: { total: totalPlayers, active24h },
    leaderboard,
  };
}

/** 管理画面 HTML（ダークテーマ、自動更新） */
export function getStatsHtml(): string {
  return \`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Stats Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0f0f23; color: #e0e0ff; font-family: 'Segoe UI', sans-serif; padding: 20px; }
  h1 { text-align: center; font-size: 24px; margin-bottom: 24px; color: #7777ff; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; max-width: 960px; margin: 0 auto; }
  .card { background: #1a1a3e; border-radius: 12px; padding: 20px; border: 1px solid #2a2a5e; }
  .card h2 { font-size: 14px; color: #8888cc; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 1px; }
  .stat-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #2a2a4e; }
  .stat-row:last-child { border-bottom: none; }
  .stat-label { color: #aaaacc; }
  .stat-value { font-weight: bold; font-size: 18px; }
  .stat-value.green { color: #44ff88; }
  .stat-value.yellow { color: #ffcc44; }
  .stat-value.blue { color: #44aaff; }
  .stat-value.purple { color: #aa77ff; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; color: #8888cc; font-size: 12px; padding: 8px 4px; border-bottom: 1px solid #2a2a5e; }
  td { padding: 8px 4px; border-bottom: 1px solid #1a1a3e; }
  .rank { color: #ffcc44; font-weight: bold; }
  .streak { color: #ff6644; }
  .footer { text-align: center; margin-top: 24px; color: #555577; font-size: 12px; }
  #status { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #44ff88; margin-right: 6px; }
</style>
</head>
<body>
<h1>📊 Game Stats Dashboard</h1>
<div class="grid">
  <div class="card">
    <h2>🟢 リアルタイム</h2>
    <div class="stat-row"><span class="stat-label">オンライン</span><span class="stat-value green" id="online">-</span></div>
    <div class="stat-row"><span class="stat-label">待機中</span><span class="stat-value yellow" id="inQueue">-</span></div>
    <div class="stat-row"><span class="stat-label">対戦中</span><span class="stat-value blue" id="inGame">-</span></div>
    <div class="stat-row"><span class="stat-label">ルーム数</span><span class="stat-value" id="activeRooms">-</span></div>
  </div>
  <div class="card">
    <h2>⚔️ 対戦統計</h2>
    <div class="stat-row"><span class="stat-label">今日</span><span class="stat-value green" id="today">-</span></div>
    <div class="stat-row"><span class="stat-label">今週</span><span class="stat-value blue" id="week">-</span></div>
    <div class="stat-row"><span class="stat-label">今月</span><span class="stat-value purple" id="month">-</span></div>
    <div class="stat-row"><span class="stat-label">累計</span><span class="stat-value" id="total">-</span></div>
    <div class="stat-row"><span class="stat-label">今日 CPU</span><span class="stat-value yellow" id="todayCpu">-</span></div>
    <div class="stat-row"><span class="stat-label">今日 PvP</span><span class="stat-value green" id="todayPvp">-</span></div>
  </div>
  <div class="card">
    <h2>👥 プレイヤー</h2>
    <div class="stat-row"><span class="stat-label">総数</span><span class="stat-value blue" id="totalPlayers">-</span></div>
    <div class="stat-row"><span class="stat-label">24時間アクティブ</span><span class="stat-value green" id="active24h">-</span></div>
  </div>
  <div class="card" style="grid-column: 1 / -1;">
    <h2>🏆 ランキング TOP10</h2>
    <table>
      <thead><tr><th>#</th><th>ニックネーム</th><th>勝</th><th>敗</th><th>分</th><th>🔥連勝</th><th>最高</th></tr></thead>
      <tbody id="leaderboard"><tr><td colspan="7" style="text-align:center;color:#555">読み込み中...</td></tr></tbody>
    </table>
  </div>
</div>
<div class="footer"><span id="status"></span>30秒ごとに自動更新 | <span id="lastUpdate">-</span></div>
<script>
async function refresh() {
  try {
    const res = await fetch('/api/stats');
    const d = await res.json();
    document.getElementById('online').textContent = d.realtime.online;
    document.getElementById('inQueue').textContent = d.realtime.inQueue;
    document.getElementById('inGame').textContent = d.realtime.inGame;
    document.getElementById('activeRooms').textContent = d.realtime.activeRooms;
    document.getElementById('today').textContent = d.matches.today;
    document.getElementById('week').textContent = d.matches.week;
    document.getElementById('month').textContent = d.matches.month;
    document.getElementById('total').textContent = d.matches.total;
    document.getElementById('todayCpu').textContent = d.matches.todayCpu;
    document.getElementById('todayPvp').textContent = d.matches.todayPvp;
    document.getElementById('totalPlayers').textContent = d.players.total;
    document.getElementById('active24h').textContent = d.players.active24h;
    const tbody = document.getElementById('leaderboard');
    if (d.leaderboard.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#555">まだデータがありません</td></tr>';
    } else {
      tbody.innerHTML = d.leaderboard.map((p, i) =>
        '<tr><td class="rank">' + (i+1) + '</td><td>' + p.nickname + '</td><td>' + p.wins +
        '</td><td>' + p.losses + '</td><td>' + p.draws + '</td><td class="streak">' +
        (p.streak > 0 ? p.streak : '-') + '</td><td>' + p.bestStreak + '</td></tr>'
      ).join('');
    }
    document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString('ja-JP');
    document.getElementById('status').style.background = '#44ff88';
  } catch (e) {
    document.getElementById('status').style.background = '#ff4444';
  }
}
refresh();
setInterval(refresh, 30000);
</script>
</body>
</html>\`;
}
`;

/** src/net/protocol.ts — メッセージプロトコル型定義（クライアント・サーバー共有） */
export const PHASER_PROTOCOL = `/**
 * 対戦メッセージプロトコル
 *
 * Client → Server, Server → Client の両方向メッセージ型を定義。
 * server/ と src/ の両方から import される。
 */

/* ---- Client → Server ---- */

export interface JoinMessage {
  type: 'join';
  nickname: string;
}

export interface MoveMessage {
  type: 'move';
  action: any;
}

export interface ForfeitMessage {
  type: 'forfeit';
}

export interface RematchMessage {
  type: 'rematch';
}

export interface LeaveMessage {
  type: 'leave';
}

export type ClientMessage = JoinMessage | MoveMessage | ForfeitMessage | RematchMessage | LeaveMessage;

/* ---- Server → Client ---- */

export interface WaitingMessage {
  type: 'waiting';
  position: number;
}

export interface MatchedMessage {
  type: 'matched';
  roomId: string;
  gameName: string;
  opponent: { nickname: string; isCpu: boolean };
  yourTurn: boolean;
  gameState: any;
}

export interface StateMessage {
  type: 'state';
  gameState: any;
  yourTurn: boolean;
}

export interface ResultMessage {
  type: 'result';
  winner: 'you' | 'opponent' | 'draw';
  stats: {
    wins: number;
    losses: number;
    draws: number;
    streak: number;
    bestStreak: number;
  } | null;
}

export interface OpponentLeftMessage {
  type: 'opponent_left';
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export interface RematchRequestMessage {
  type: 'rematch_request';
  from: string;
}

export type ServerMessage =
  | WaitingMessage
  | MatchedMessage
  | StateMessage
  | ResultMessage
  | OpponentLeftMessage
  | ErrorMessage
  | RematchRequestMessage;
`;

/** src/net/GameClient.ts — WebSocket クライアント（Phaser から使用） */
export const PHASER_GAME_CLIENT = `import type { ServerMessage } from './protocol';

/**
 * ゲーム WebSocket クライアント（シングルトン）
 *
 * Phaser シーンからサーバーへの通信を管理。
 * 自動再接続付き。
 */
export class GameClient {
  private static instance: GameClient;
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<(data: any) => void>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor() {}

  static getInstance(): GameClient {
    if (!GameClient.instance) {
      GameClient.instance = new GameClient();
    }
    return GameClient.instance;
  }

  /** WebSocket に接続 */
  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = \`\${proto}//\${location.host}/ws\`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('🎮 WS connected');
      this.emit('connected', {});
    };

    this.ws.onmessage = (e) => {
      try {
        const msg: ServerMessage = JSON.parse(e.data);
        this.emit(msg.type, msg);
      } catch {
        console.error('WS parse error');
      }
    };

    this.ws.onclose = () => {
      console.log('🎮 WS disconnected');
      this.emit('disconnected', {});
      // 3秒後に再接続
      this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    };
  }

  /** メッセージ送信 */
  send(data: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  /** イベントリスナー登録 */
  on(type: string, callback: (data: any) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(callback);
  }

  /** イベントリスナー解除 */
  off(type: string, callback: (data: any) => void): void {
    this.listeners.get(type)?.delete(callback);
  }

  /** イベント発火 */
  private emit(type: string, data: any): void {
    this.listeners.get(type)?.forEach((cb) => cb(data));
  }

  /** 切断 */
  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}
`;

/** src/scenes/LobbyScene.ts — ニックネーム入力 + マッチメイキング待機画面 */
export const PHASER_LOBBY_SCENE = `import Phaser from 'phaser';
import { GameClient } from '../net/GameClient';

/**
 * ロビーシーン: ニックネーム入力 → マッチメイキング待機
 */
export class LobbyScene extends Phaser.Scene {
  private client!: GameClient;
  private statusText!: Phaser.GameObjects.Text;
  private nicknameInput!: HTMLInputElement;
  private joinBtn!: HTMLButtonElement;
  private countdownText!: Phaser.GameObjects.Text;
  private waitTimer: ReturnType<typeof setInterval> | null = null;
  private waitStartTime = 0;
  private isWaiting = false;

  constructor() {
    super({ key: 'LobbyScene' });
  }

  create(): void {
    this.client = GameClient.getInstance();
    this.client.connect();

    // タイトル
    this.add.text(240, 80, '⚔️ 対戦ロビー', {
      fontSize: '36px',
      color: '#e0e0ff',
      fontFamily: 'Arial, sans-serif',
      fontStyle: 'bold',
    }).setOrigin(0.5);

    // ゲーム名
    this.add.text(240, 130, '棒消しゲーム (Nim)', {
      fontSize: '20px',
      color: '#8888aa',
      fontFamily: 'Arial, sans-serif',
    }).setOrigin(0.5);

    // ニックネーム入力（HTML）
    this.createInputElements();

    // ステータステキスト
    this.statusText = this.add.text(240, 360, '', {
      fontSize: '18px',
      color: '#aaaacc',
      fontFamily: 'Arial, sans-serif',
      align: 'center',
    }).setOrigin(0.5);

    // カウントダウン
    this.countdownText = this.add.text(240, 400, '', {
      fontSize: '48px',
      color: '#ffcc00',
      fontFamily: 'Arial, sans-serif',
      fontStyle: 'bold',
    }).setOrigin(0.5);

    // ルール説明
    this.add.text(240, 520, '📖 ルール', {
      fontSize: '22px',
      color: '#e0e0ff',
      fontFamily: 'Arial, sans-serif',
      fontStyle: 'bold',
    }).setOrigin(0.5);

    const rules = [
      '21本の棒がある',
      '交互に 1〜3 本取る',
      '最後の1本を取ったら負け！',
    ];
    rules.forEach((text, i) => {
      this.add.text(240, 560 + i * 28, text, {
        fontSize: '16px',
        color: '#8888aa',
        fontFamily: 'Arial, sans-serif',
      }).setOrigin(0.5);
    });

    // WS イベント
    this.client.on('waiting', () => {
      this.isWaiting = true;
      this.waitStartTime = Date.now();
      this.statusText.setText('対戦相手を探しています...');
      this.startCountdown();
    });

    this.client.on('matched', (msg: any) => {
      this.isWaiting = false;
      this.stopCountdown();
      this.removeInputElements();
      this.scene.start('GameScene', {
        roomId: msg.roomId,
        opponent: msg.opponent,
        yourTurn: msg.yourTurn,
        gameState: msg.gameState,
        gameName: msg.gameName,
      });
    });
  }

  /** HTML 入力要素を作成 */
  private createInputElements(): void {
    // ニックネーム
    const saved = localStorage.getItem('devrelay-nickname') || '';
    this.nicknameInput = document.createElement('input');
    this.nicknameInput.type = 'text';
    this.nicknameInput.placeholder = 'ニックネーム';
    this.nicknameInput.value = saved;
    this.nicknameInput.maxLength = 20;
    Object.assign(this.nicknameInput.style, {
      position: 'absolute',
      left: '50%',
      top: '38%',
      transform: 'translateX(-50%)',
      width: '200px',
      padding: '12px 16px',
      fontSize: '18px',
      border: '2px solid #4444aa',
      borderRadius: '8px',
      background: '#2a2a4a',
      color: '#e0e0ff',
      textAlign: 'center',
      outline: 'none',
      zIndex: '100',
    });

    // 参加ボタン
    this.joinBtn = document.createElement('button');
    this.joinBtn.textContent = '🎮 対戦する';
    Object.assign(this.joinBtn.style, {
      position: 'absolute',
      left: '50%',
      top: '47%',
      transform: 'translateX(-50%)',
      padding: '12px 32px',
      fontSize: '20px',
      fontWeight: 'bold',
      border: 'none',
      borderRadius: '8px',
      background: '#5555cc',
      color: '#ffffff',
      cursor: 'pointer',
      zIndex: '100',
    });

    this.joinBtn.addEventListener('click', () => this.joinLobby());
    this.nicknameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.joinLobby();
    });

    document.body.appendChild(this.nicknameInput);
    document.body.appendChild(this.joinBtn);
  }

  /** ロビーに参加 */
  private joinLobby(): void {
    const nickname = this.nicknameInput.value.trim() || 'Guest';
    localStorage.setItem('devrelay-nickname', nickname);
    this.nicknameInput.style.display = 'none';
    this.joinBtn.style.display = 'none';
    this.client.send({ type: 'join', nickname });
  }

  /** カウントダウン開始 */
  private startCountdown(): void {
    this.stopCountdown();
    this.waitTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.waitStartTime) / 1000);
      const remaining = Math.max(0, 10 - elapsed);
      this.countdownText.setText(String(remaining));
      if (remaining <= 0) {
        this.countdownText.setText('CPU と対戦！');
        this.stopCountdown();
      }
    }, 200);
  }

  /** カウントダウン停止 */
  private stopCountdown(): void {
    if (this.waitTimer) {
      clearInterval(this.waitTimer);
      this.waitTimer = null;
    }
    this.countdownText.setText('');
  }

  /** HTML 要素を削除 */
  private removeInputElements(): void {
    this.nicknameInput?.remove();
    this.joinBtn?.remove();
  }

  shutdown(): void {
    this.stopCountdown();
    this.removeInputElements();
  }
}
`;

/** src/scenes/ResultScene.ts — 勝敗表示 + 連勝カウンター + リマッチボタン */
export const PHASER_RESULT_SCENE = `import Phaser from 'phaser';
import { GameClient } from '../net/GameClient';

/**
 * 結果シーン: 勝敗表示 + 統計 + リマッチ/ロビーに戻るボタン
 */
export class ResultScene extends Phaser.Scene {
  private client!: GameClient;

  constructor() {
    super({ key: 'ResultScene' });
  }

  create(data: {
    winner: 'you' | 'opponent' | 'draw';
    stats: { wins: number; losses: number; draws: number; streak: number; bestStreak: number } | null;
    opponentNickname: string;
    isCpu: boolean;
  }): void {
    this.client = GameClient.getInstance();

    // 結果タイトル
    const resultText = data.winner === 'you' ? '🎉 勝利！' : data.winner === 'opponent' ? '😢 敗北...' : '🤝 引き分け';
    const resultColor = data.winner === 'you' ? '#44ff44' : data.winner === 'opponent' ? '#ff4444' : '#ffcc00';

    this.add.text(240, 100, resultText, {
      fontSize: '48px',
      color: resultColor,
      fontFamily: 'Arial, sans-serif',
      fontStyle: 'bold',
    }).setOrigin(0.5);

    // 対戦相手
    const vsText = data.isCpu ? 'vs CPU' : \`vs \${data.opponentNickname}\`;
    this.add.text(240, 160, vsText, {
      fontSize: '20px',
      color: '#8888aa',
      fontFamily: 'Arial, sans-serif',
    }).setOrigin(0.5);

    // 統計
    if (data.stats) {
      const { wins, losses, draws, streak, bestStreak } = data.stats;

      this.add.text(240, 240, '📊 戦績', {
        fontSize: '24px',
        color: '#e0e0ff',
        fontFamily: 'Arial, sans-serif',
        fontStyle: 'bold',
      }).setOrigin(0.5);

      this.add.text(240, 280, \`\${wins}勝 \${losses}敗 \${draws}分\`, {
        fontSize: '22px',
        color: '#ccccee',
        fontFamily: 'Arial, sans-serif',
      }).setOrigin(0.5);

      if (streak > 0) {
        const streakColor = streak >= 5 ? '#ff4444' : streak >= 3 ? '#ffcc00' : '#44ff44';
        this.add.text(240, 320, \`🔥 \${streak}連勝中！\`, {
          fontSize: '28px',
          color: streakColor,
          fontFamily: 'Arial, sans-serif',
          fontStyle: 'bold',
        }).setOrigin(0.5);
      }

      if (bestStreak > 1) {
        this.add.text(240, 360, \`最高記録: \${bestStreak}連勝\`, {
          fontSize: '16px',
          color: '#6666aa',
          fontFamily: 'Arial, sans-serif',
        }).setOrigin(0.5);
      }
    }

    // リマッチボタン
    this.createButton(240, 460, '🔄 リマッチ', '#5555cc', () => {
      this.client.send({ type: 'rematch' });
      // matched イベントでリスタート
      this.client.on('matched', (msg: any) => {
        this.scene.start('GameScene', {
          roomId: msg.roomId,
          opponent: msg.opponent,
          yourTurn: msg.yourTurn,
          gameState: msg.gameState,
          gameName: msg.gameName,
        });
      });
    });

    // ロビーに戻るボタン
    this.createButton(240, 530, '🏠 ロビーに戻る', '#666688', () => {
      this.client.send({ type: 'leave' });
      this.scene.start('LobbyScene');
    });
  }

  /** ボタン作成ヘルパー */
  private createButton(x: number, y: number, label: string, color: string, onClick: () => void): void {
    const bg = this.add.graphics();
    const w = 220;
    const h = 50;
    bg.fillStyle(parseInt(color.replace('#', ''), 16), 1);
    bg.fillRoundedRect(x - w / 2, y - h / 2, w, h, 8);
    bg.setInteractive(
      new Phaser.Geom.Rectangle(x - w / 2, y - h / 2, w, h),
      Phaser.Geom.Rectangle.Contains
    );
    bg.on('pointerdown', onClick);

    this.add.text(x, y, label, {
      fontSize: '20px',
      color: '#ffffff',
      fontFamily: 'Arial, sans-serif',
      fontStyle: 'bold',
    }).setOrigin(0.5);
  }
}
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
  'src/scenes/LobbyScene.ts': PHASER_LOBBY_SCENE,
  'src/scenes/ResultScene.ts': PHASER_RESULT_SCENE,
  'src/net/protocol.ts': PHASER_PROTOCOL,
  'src/net/GameClient.ts': PHASER_GAME_CLIENT,
  'src/utils/SoundManager.ts': PHASER_SOUND_MANAGER,
  'src/types/index.ts': PHASER_TYPES_INDEX,
  'src/types/jsfxr.d.ts': PHASER_JSFXR_DTS,
  'prisma/schema.prisma': PHASER_PRISMA_SCHEMA,
  'server/game-adapter.ts': PHASER_GAME_ADAPTER,
  'server/adapters/index.ts': PHASER_ADAPTER_INDEX,
  'server/adapters/nim-adapter.ts': PHASER_NIM_ADAPTER,
  'server/db.ts': PHASER_DB,
  'server/ws-server.ts': PHASER_WS_SERVER,
  'server/matchmaker.ts': PHASER_MATCHMAKER,
  'server/room.ts': PHASER_ROOM,
  'server/cpu-player.ts': PHASER_CPU_PLAYER,
  'server/stats-api.ts': PHASER_STATS_API,
  'server/vite-ws-plugin.ts': PHASER_WS_PLUGIN,
  '.claude/skills/phaser-gamedev/SKILL.md': PHASER_SKILL_MD,
};
