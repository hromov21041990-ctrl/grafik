# Telegram notifications for support 2.0

Project: vyavhynnybsinkiievbu. Function: pvz2-support.

## Secrets and activation
1. Revoke every previously exposed bot token in BotFather with /revoke.
2. Save the replacement only in Supabase Edge Function Secrets:
   https://supabase.com/dashboard/project/vyavhynnybsinkiievbu/functions/secrets
   - TELEGRAM_BOT_TOKEN: replacement token
   - TELEGRAM_CHAT_ID: -5492444972
3. Ensure the bot belongs to this group and may send messages.
Never put a bot token in GitHub, frontend code, a browser URL, a chat message, or a committed env file.
Secrets are read at request time; changing them does not require redeployment.

## Behavior
The original guest form and application session validation remain in place.
The function commits the ticket first, then makes one server-side Telegram sendMessage call.
It reads only the two Edge Function Secrets. The group must match -5492444972.
Messages use plain text with previews disabled and a bounded length.
Only Telegram ok=true with a message ID and the expected group ID records telegram_notified_at.
Telegram failures keep the ticket and store a safe error code in telegram_delivery_error.
No token, Telegram response description, or exception text is stored or logged.
A failure recording delivery status is logged with the ticket ID only; the saved ticket remains.
The frontend still receives {ok:true,ticketId} for a saved ticket, regardless of Telegram outcome.
Existing frontend, registration, other functions, and database schema are unchanged.

## Deployment
Deploy this directory as pvz2-support with verify_jwt=false, matching its previous configuration.
This preserves guest support and the existing custom pvz2_sessions authentication.
Do not enable gateway JWT verification for the application's custom session tokens.
Dependencies remain pinned to the existing supabase-js 2.95.0.

## Verification
Run telegram.test.mjs with Node 24 using node --test.
Submit one clearly labelled test using the support form at:
https://hromov21041990-ctrl.github.io/grafik/v2/
Use a real contact email when testing manually; no separate registration is required.
Check the ticket ID returned by the form in the private Supabase table:
select id, created_at, telegram_notified_at, telegram_delivery_error
from public.pvz2_support_tickets
where id = '<returned-ticket-uuid>';
Confirm the Telegram group received a message containing this same ID.
Treat delivery as verified only after both confirmation and the non-null marker are present.
A successful form submission alone proves only database acceptance.

## Pending notifications
The database is the source of truth:
select id, created_at, telegram_delivery_error
from public.pvz2_support_tickets
where telegram_notified_at is null
order by created_at;
There is no automatic replay. Correct secrets or group permissions before retrying notifications.
For delivery_unknown errors or a missing status marker, check the group for the ticket ID before replay:
a timeout can occur after Telegram accepted the message, so blind retries may duplicate it.
Do not resubmit the original ticket merely to retry its Telegram notification.

Safe codes:
- telegram_secrets_missing: both Edge Function Secrets are empty.
- telegram_bot_token_missing: TELEGRAM_BOT_TOKEN is missing or empty.
- telegram_chat_id_missing: TELEGRAM_CHAT_ID is missing or empty.
- telegram_chat_id_mismatch: group secret differs from the requested group.
- telegram_token_invalid_format: replacement token has malformed characters.
- telegram_http_401: token rejected; check rotation and the stored value.
- telegram_http_403: check group membership and send permissions.
- telegram_http_400: check the target group and message configuration.
- telegram_http_429: Telegram rate limit.
- telegram_api_rejected / telegram_invalid_response / telegram_invalid_confirmation: no valid delivery proof.
- telegram_timeout_delivery_unknown / telegram_network_error_delivery_unknown: delivery is uncertain.

Docs:
https://supabase.com/docs/guides/functions/secrets
https://core.telegram.org/bots/api#sendmessage
