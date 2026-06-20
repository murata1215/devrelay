/**
 * Vite + React Web テンプレート定義
 *
 * Manager の scaffold 機能で展開されるファイル群。
 * プレースホルダー: {{NAME}} → プロジェクト名
 *
 * 構成: Vite + React 19 + TypeScript + Tailwind CSS v4
 * dev サーバー起動可能な最小雛形。
 */

/** テンプレートファイル: パス → 内容 */
export const WEB_TEMPLATE_FILES: Record<string, string> = {

  // ── package.json ──────────────────────────────────────────
  'package.json': `{
  "name": "{{NAME}}",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.4.0",
    "typescript": "^5.7.0",
    "vite": "^6.0.0",
    "tailwindcss": "^4.0.0",
    "@tailwindcss/vite": "^4.0.0"
  }
}
`,

  // ── vite.config.ts ────────────────────────────────────────
  'vite.config.ts': `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  plugins: [
    react(),
    tailwindcss(),
  ],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
`,

  // ── tsconfig.json ─────────────────────────────────────────
  'tsconfig.json': `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["src"]
}
`,

  // ── index.html ────────────────────────────────────────────
  'index.html': `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{{NAME}}</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
`,

  // ── src/main.tsx ──────────────────────────────────────────
  'src/main.tsx': `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,

  // ── src/App.tsx ───────────────────────────────────────────
  'src/App.tsx': `/** メインアプリケーションコンポーネント */
export default function App() {
  return (
    <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
      <div className="text-center space-y-4">
        <h1 className="text-4xl font-bold">{{NAME}}</h1>
        <p className="text-gray-400">プロジェクトの雛形が作成されました。ここから実装を始めましょう。</p>
      </div>
    </div>
  );
}
`,

  // ── src/index.css ─────────────────────────────────────────
  'src/index.css': `@import "tailwindcss";
`,

  // ── .gitignore ────────────────────────────────────────────
  '.gitignore': `node_modules
dist
*.local
.env
`,
};

/** scaffold 後に配置する CLAUDE.md テンプレート */
export const WEB_CLAUDE_MD = `# {{NAME}}

Vite + React 19 + TypeScript + Tailwind CSS v4 のプロジェクト。

## 技術スタック
- **フロントエンド**: React 19 + TypeScript
- **スタイル**: Tailwind CSS v4
- **ビルド**: Vite 6

## 開発コマンド
\`\`\`bash
pnpm dev      # 開発サーバー起動
pnpm build    # プロダクションビルド
pnpm preview  # ビルド結果のプレビュー
\`\`\`
`;
