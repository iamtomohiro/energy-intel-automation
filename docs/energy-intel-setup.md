# Energy Intel Digest Setup

このシステムは、Google Sheet `config` の行を3ソースずつ巡回し、Gmailの最新配信を確認して、更新があればOpenAIで戦略示唆を抽出し、Slack `#energy-intel` に投稿します。

## Spreadsheet

対象:

https://docs.google.com/spreadsheets/d/1ovlkKK6EKxM4Lr75ngR1cceHf6pV6hpfCEl_wct03VY/edit

`config` の列:

```text
feed_name | source_type | gmail_from | gmail_query | selector | channel | enabled | segment | region | priority
```

初回実行時に以下のシートを自動作成します。

- `system_state`: 巡回位置とソース別の最終処理受信時刻
- `all_outputs`: 全ソース横断の処理ログ
- `{feed_name}`: ソース別ログ

## GitHub Secrets

GitHub repository の `Settings` → `Secrets and variables` → `Actions` → `New repository secret` で以下を登録します。

```text
OPENAI_API_KEY
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REFRESH_TOKEN
SLACK_WEBHOOK_URL
```

## Slack Webhook

1. Slack API の Incoming Webhooks app を作成します。
2. 投稿先チャンネルとして `#energy-intel` を選びます。
3. 発行された Webhook URL を `SLACK_WEBHOOK_URL` として GitHub Secrets に登録します。

Webhook側でチャンネル固定になる場合があります。その場合も `#energy-intel` を選んで作れば問題ありません。

## Google OAuth

Gmailを読むため、個人Googleアカウント `fortunaoi132@gmail.com` のOAuth refresh token が必要です。

必要スコープ:

```text
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/spreadsheets
```

OAuth同意画面とOAuth Clientを作り、refresh token を取得して `GOOGLE_REFRESH_TOKEN` に登録します。

### Step-by-step

1. Google Cloud Consoleで新しいプロジェクトを作ります。
2. `APIs & Services` → `Enabled APIs & services` から以下を有効化します。
   - Gmail API
   - Google Sheets API
3. `OAuth consent screen` を設定します。
   - User Type は外部でも内部でも可
   - Test users に `fortunaoi132@gmail.com` を追加
4. `Credentials` → `Create Credentials` → `OAuth client ID` を選びます。
5. Application type は `Web application` を選びます。
6. Authorized redirect URIs に以下を追加します。

```text
http://localhost:3000/oauth2callback
```

7. 作成後に表示される Client ID と Client Secret を `.env` に一時的に入れます。

```text
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

8. ローカルで以下を実行します。

```powershell
npm run google:auth
```

9. ターミナルに表示されたURLをブラウザで開き、`fortunaoi132@gmail.com` で許可します。
10. ターミナルに表示された refresh token を `GOOGLE_REFRESH_TOKEN` としてGitHub Secretsに登録します。

## Schedule

GitHub Actions はUTCで動きます。

- 05:00 JST = 20:00 UTC 前日
- 11:00 JST = 02:00 UTC

`.github/workflows/energy-intel.yml` にこの2回のcronを設定済みです。

## Local Test

`.env` に同じ値を入れてから実行します。

```powershell
npm install
npm run energy:intel
```

## Behavior

- 初回は `config` の冒頭から有効な3ソースを確認します。
- 次回は前回確認した次の行から、また有効な3ソースを確認します。
- 各ソースで、前回処理したメール受信日時より新しい配信があるかをGmailで検索します。
- 複数の新着があっても、最新の1件だけ処理します。
- `gmail_query` がある場合はそれを優先し、空の場合は `from:{gmail_from}` で検索します。
- 出力は日本語、Markdown見出しは英語です。
