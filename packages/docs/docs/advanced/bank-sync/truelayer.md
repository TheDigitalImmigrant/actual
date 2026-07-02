# TrueLayer Setup

[TrueLayer](https://truelayer.com/) is an open banking provider with good coverage of UK (and some EU) banks. It is a useful alternative where GoCardless is unavailable.

## Create a TrueLayer application

1. Sign up and sign in to the TrueLayer Console: https://console.truelayer.com/
2. Create a new application. Note its **Client ID** and **Client Secret** — the secret is only shown once.
3. Enable the **Data API** (account information / AIS) for the application.
4. Add your Actual Budget redirect URI to the application's **Allowed redirect URIs**. It must use `https` and end with `/truelayer/auth_callback`:

   ```text
   https://actualbudget.example.com/truelayer/auth_callback
   ```

:::note
Connecting your own bank accounts works while the application is in TrueLayer's test/sandbox mode. Connecting other people's accounts requires TrueLayer to grant your application live/production access.
:::

## Configure Actual Budget

Go to **More → Settings → Bank Sync**, choose **Set up TrueLayer**, and paste your **Client ID** and **Client Secret**.

If you self-host, you can instead provide the credentials through environment variables on the server, which keeps them out of the database:

```text
TRUELAYER_CLIENT_ID=your-client-id
TRUELAYER_CLIENT_SECRET=your-client-secret
```

## Link an account

1. Open an Actual Budget account and select **Link account → TrueLayer**.
2. Choose your country and bank from the list.
3. A window opens on TrueLayer; authenticate with your bank and approve access.
4. Back in Actual Budget, select the accounts (and credit cards) you want to link.

Bank access is granted for up to **90 days**, after which you will need to link the account again — Actual Budget will show a sync error prompting you to reconnect when the consent expires.
