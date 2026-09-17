# matomeru

OpenAI APIで会議音声から話者推定付きの文字起こしと議事録を作るDeno +
SQLiteアプリです。WebAudioによるリアルタイム文字起こしにも対応しています。

```sh
deno task dev
```

`.env`には`PORT`、`ADMIN_USER_ID`、`PASSKEY_RP_ID`、`PASSKEY_ORIGIN`、`POINTS_PER_USD`、`OPENAI_API_KEY`、`OPENAI_MODEL`を設定します。`POINTS_PER_USD=1700`は、API料金1ドルに対して1700pt（ドル料金の1.7倍）として換算します。新規登録時のIDは128bitのランダム値で生成され、`ADMIN_USER_ID`と一致するユーザーが管理者になります。認証にはパスキーを使用します。話者分離モデルは`OPENAI_TRANSCRIBE_MODEL`、Realtime文字起こしモデルは`OPENAI_REALTIME_TRANSCRIBE_MODEL`で変更できます。

## デプロイ手順

### 1. 配置

サーバーにDeno 2.xをインストールし、リポジトリを配置します。

```sh
git clone <repository-url> matomeru
cd matomeru
cp .env.example .env
```

### 2. 本番用環境変数

`.env`を編集します。`OPENAI_API_KEY`などの秘密情報はGitへ登録しません。

```dotenv
PORT=8101
OPENAI_API_KEY=設定したAPIキー
OPENAI_MODEL=gpt-4o-mini
OPENAI_TRANSCRIBE_MODEL=gpt-4o-transcribe-diarize
OPENAI_REALTIME_TRANSCRIBE_MODEL=gpt-live-transcribe
POINTS_PER_USD=1700

# 例: https://minutes.example.com で公開する場合
PASSKEY_RP_ID=minutes.example.com
PASSKEY_ORIGIN=https://minutes.example.com
PASSKEY_RP_NAME=matomeru
ADMIN_USER_ID=
```

`PASSKEY_ORIGIN`は実際にブラウザで開くoriginと完全に一致させます。公開環境ではHTTPSが
必要です。`PASSKEY_RP_ID`は通常、公開ドメイン名です。

### 3. 起動

```sh
deno task start
```

初回起動時に`data/matomeru.sqlite`と必要なテーブルが作成されます。外部モジュールの
import許可を含む起動権限は`deno.json`の`start`タスクで指定済みです。

### 4. リバースプロキシ

NginxなどのTLS終端を前段に置く場合は、通常のHTTPに加えて`/api/realtime`のWebSocket
Upgradeを転送します。ブラウザからは`https://公開ドメイン/`でアクセスします。

### 5. 管理者設定

新規登録で発行されたIDを`ADMIN_USER_ID`へ設定して再起動すると、そのユーザーが管理者に
なります。`ADMIN_USER_ID`を事前に設定している場合は、そのIDを最初のパスキー登録に 使用できます。

```sh
deno task start
```

### 6. 動作確認

```sh
deno fmt --check
deno lint
deno check --allow-import src/server.ts
deno test --allow-read --allow-write --allow-env --allow-import
```

ログイン後、マイク許可、パスキー登録、リアルタイム録音、議事録JSONダウンロードを確認 します。

### 運用上の注意

- `data/`は永続ディスクへ置き、定期的にバックアップします。
- `.env`、SQLite本体、WAL/SHMファイルを公開・commitしません。
- 依存モジュールを更新する場合は、`deno.lock`も確認してからデプロイします。
- サーバー更新時は`deno task start`を停止してから再起動します。
