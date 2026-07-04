/**
 * Agent 側の scaffold テンプレート定義（実体）
 *
 * テンプレートの ID / OS 制限 / 必須ツールのメタ情報は
 * packages/shared の SCAFFOLD_TEMPLATE_DEFS に定義されている。
 * このファイルは各テンプレートの「実体」（展開ファイル・生成コマンド・CLAUDE.md）を持つ。
 * scaffold ハンドラ（connection.ts）から動的 import される。
 *
 * Note: macos 版と同一内容を保持する（Xcode は macOS でのみ生成可能だが、
 * OS 制限はサーバー側で検証するため定義自体は両 Agent で共有して問題ない）。
 */

/** 生成後に実行する非致命的な追加ステップ（依存インストール等） */
export interface ScaffoldPostInstall {
  /** 実行に必要な CLI ツール名（which/where で検出。未検出ならスキップ） */
  tool: string;
  /** 実行コマンド（cwd = projectDir） */
  command: string;
  /** タイムアウト（ms） */
  timeout: number;
}

/** scaffold テンプレートの実体定義 */
export interface ScaffoldTemplateImpl {
  /** 生成方式: 'files' = 静的ファイル展開, 'command' = CLI ジェネレータ実行 */
  kind: 'files' | 'command';
  /** 生成に必須の CLI ツール（which/where で事前検出。未検出なら致命的エラー） */
  requiredTool?: string;
  /** requiredTool 未検出時にユーザーへ表示する案内メッセージ */
  missingToolHint?: string;
  /** files kind: 展開するファイル群（{{NAME}} を置換） */
  files?: Record<string, string>;
  /** command kind: 生成コマンドを構築する（cwd = projectDir で実行、致命的） */
  buildCommand?: (name: string) => string;
  /** command kind: 生成コマンドのタイムアウト（ms） */
  commandTimeout?: number;
  /** ファイル展開/生成後に実行する追加コマンド（致命的。例: xcodegen generate） */
  postCommand?: (name: string) => string;
  /** postCommand のタイムアウト（ms） */
  postCommandTimeout?: number;
  /** 生成後に配置する CLAUDE.md（{{NAME}} を置換） */
  claudeMd: string;
  /** 生成後の非致命的な依存インストールステップ */
  postInstall?: ScaffoldPostInstall;
}

// -----------------------------------------------------------------------------
// vite-react-web: Vite + React 19 + TypeScript + Tailwind CSS v4
// -----------------------------------------------------------------------------

/** Vite + React Web テンプレートファイル群 */
export const WEB_TEMPLATE_FILES: Record<string, string> = {

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

  'src/index.css': `@import "tailwindcss";
`,

  '.gitignore': `node_modules
dist
*.local
.env
`,
};

/** vite-react-web の CLAUDE.md */
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

// -----------------------------------------------------------------------------
// android-kotlin: Gradle Kotlin DSL の最小 Android アプリ
// -----------------------------------------------------------------------------

/** Android (Kotlin) テンプレートファイル群 */
const ANDROID_TEMPLATE_FILES: Record<string, string> = {

  'settings.gradle.kts': `pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "{{NAME}}"
include(":app")
`,

  'build.gradle.kts': `plugins {
    id("com.android.application") version "8.5.0" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
`,

  'gradle.properties': `org.gradle.jvmargs=-Xmx2048m
android.useAndroidX=true
kotlin.code.style=official
`,

  'app/build.gradle.kts': `plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.devrelay.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.devrelay.app"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
}
`,

  'app/src/main/AndroidManifest.xml': `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application
        android:allowBackup="true"
        android:label="{{NAME}}"
        android:theme="@style/Theme.Material3.DayNight.NoActionBar">
        <activity
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`,

  'app/src/main/kotlin/com/devrelay/app/MainActivity.kt': `package com.devrelay.app

import android.os.Bundle
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/** メインアクティビティ: 最小の TextView を表示する */
class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val textView = TextView(this).apply {
            text = "{{NAME}}"
            textSize = 24f
        }
        setContentView(textView)
    }
}
`,

  '.gitignore': `*.iml
.gradle
/local.properties
/.idea
.DS_Store
/build
/app/build
/captures
`,
};

/** android-kotlin の CLAUDE.md */
const ANDROID_CLAUDE_MD = `# {{NAME}}

Android (Kotlin) プロジェクト。Gradle Kotlin DSL 構成の最小アプリ。

## 技術スタック
- **言語**: Kotlin
- **ビルド**: Gradle (Kotlin DSL)
- **最小 SDK**: 24 / **ターゲット SDK**: 34
- **applicationId**: com.devrelay.app

## 開発コマンド
\`\`\`bash
./gradlew assembleDebug   # デバッグ APK ビルド
./gradlew installDebug    # 接続端末にインストール
./gradlew test            # ユニットテスト
\`\`\`

## 注意
- ビルドには Android SDK が必要です。
- gradlew（Gradle Wrapper）が無い場合は \`gradle wrapper\` を実行して生成してください。
`;

// -----------------------------------------------------------------------------
// flutter-app: flutter create による Flutter プロジェクト
// -----------------------------------------------------------------------------

/** flutter-app の CLAUDE.md */
const FLUTTER_CLAUDE_MD = `# {{NAME}}

Flutter プロジェクト（iOS / Android / Web 対応）。

## 技術スタック
- **フレームワーク**: Flutter
- **言語**: Dart

## 開発コマンド
\`\`\`bash
flutter run          # デバッグ実行（接続デバイス/エミュレータ）
flutter build apk    # Android APK ビルド
flutter build ios    # iOS ビルド（macOS のみ）
flutter test         # テスト実行
\`\`\`

## 注意
- 雛形は \`flutter create\` で生成されています。
`;

// -----------------------------------------------------------------------------
// xcode-swiftui: XcodeGen による SwiftUI 最小 iOS アプリ（macOS 専用）
// -----------------------------------------------------------------------------

/** Xcode (SwiftUI) テンプレートファイル群（xcodegen generate で .xcodeproj 生成） */
const XCODE_TEMPLATE_FILES: Record<string, string> = {

  'project.yml': `name: {{NAME}}
options:
  bundleIdPrefix: com.devrelay
  deploymentTarget:
    iOS: "17.0"
targets:
  {{NAME}}:
    type: application
    platform: iOS
    sources:
      - Sources
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.devrelay.{{NAME}}
        GENERATE_INFOPLIST_FILE: YES
        INFOPLIST_KEY_UILaunchScreen_Generation: YES
        SWIFT_VERSION: "5.0"
        TARGETED_DEVICE_FAMILY: "1,2"
`,

  'Sources/App.swift': `import SwiftUI

/** アプリのエントリーポイント */
@main
struct {{NAME}}App: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
`,

  'Sources/ContentView.swift': `import SwiftUI

/** メインコンテンツビュー */
struct ContentView: View {
    var body: some View {
        VStack(spacing: 16) {
            Text("{{NAME}}")
                .font(.largeTitle)
                .bold()
            Text("プロジェクトの雛形が作成されました。")
                .foregroundStyle(.secondary)
        }
        .padding()
    }
}

#Preview {
    ContentView()
}
`,

  '.gitignore': `.DS_Store
build/
DerivedData/
*.xcodeproj
xcuserdata/
*.xcuserstate
`,
};

/** xcode-swiftui の CLAUDE.md */
const XCODE_CLAUDE_MD = `# {{NAME}}

SwiftUI 最小 iOS アプリ（macOS 専用）。XcodeGen で .xcodeproj を生成する構成。

## 技術スタック
- **UI**: SwiftUI
- **言語**: Swift 5
- **最小 iOS**: 17.0
- **プロジェクト生成**: XcodeGen（project.yml → .xcodeproj）

## 開発コマンド
\`\`\`bash
xcodegen generate                              # project.yml から .xcodeproj を再生成
open {{NAME}}.xcodeproj                         # Xcode で開く
xcodebuild -scheme {{NAME}} -destination 'platform=iOS Simulator,name=iPhone 15' build
\`\`\`

## 注意
- ソース（Sources/）を追加・変更したら \`xcodegen generate\` で .xcodeproj を再生成してください。
- .xcodeproj は生成物のため .gitignore 対象です（project.yml を正とする）。
`;

// -----------------------------------------------------------------------------
// empty: CLAUDE.md のみの空プロジェクト
// -----------------------------------------------------------------------------

/** empty テンプレートファイル群（.gitignore のみ） */
const EMPTY_TEMPLATE_FILES: Record<string, string> = {
  '.gitignore': `.DS_Store
node_modules
.env
*.local
`,
};

/** empty の CLAUDE.md */
const EMPTY_CLAUDE_MD = `# {{NAME}}

用途未定の空プロジェクト。ここから自由に開発を始めてください。

## メモ
- このプロジェクトは DevRelay の scaffold で作成された空の雛形です。
- 技術スタックが決まったら、この CLAUDE.md に開発コマンドや設計方針を追記してください。
`;

// -----------------------------------------------------------------------------
// テンプレート実体レジストリ
// -----------------------------------------------------------------------------

/** テンプレート ID → 実体定義のマップ */
export const SCAFFOLD_TEMPLATES: Record<string, ScaffoldTemplateImpl> = {
  'vite-react-web': {
    kind: 'files',
    files: WEB_TEMPLATE_FILES,
    claudeMd: WEB_CLAUDE_MD,
    postInstall: { tool: 'npm', command: 'npm install', timeout: 120000 },
  },
  'flutter-app': {
    kind: 'command',
    requiredTool: 'flutter',
    missingToolHint:
      'Flutter SDK が見つかりません。https://docs.flutter.dev/get-started/install からインストールしてください（which flutter / where flutter で検出できる必要があります）',
    // プロジェクト名のハイフンは Dart パッケージ名に使えないため snake_case に変換
    buildCommand: (name: string) =>
      `flutter create --project-name ${name.replace(/-/g, '_')} --org com.devrelay .`,
    commandTimeout: 300000,
    claudeMd: FLUTTER_CLAUDE_MD,
  },
  'android-kotlin': {
    kind: 'files',
    files: ANDROID_TEMPLATE_FILES,
    claudeMd: ANDROID_CLAUDE_MD,
    // gradle が使えれば wrapper を生成（無ければスキップ、失敗しても非致命的）
    postInstall: { tool: 'gradle', command: 'gradle wrapper', timeout: 120000 },
  },
  'xcode-swiftui': {
    kind: 'files',
    requiredTool: 'xcodegen',
    missingToolHint:
      'XcodeGen が見つかりません。`brew install xcodegen` でインストールしてください（macOS 専用）',
    files: XCODE_TEMPLATE_FILES,
    // project.yml + Sources を展開後に .xcodeproj を生成（致命的ステップ）
    postCommand: () => 'xcodegen generate',
    postCommandTimeout: 60000,
    claudeMd: XCODE_CLAUDE_MD,
  },
  'empty': {
    kind: 'files',
    files: EMPTY_TEMPLATE_FILES,
    claudeMd: EMPTY_CLAUDE_MD,
  },
};
