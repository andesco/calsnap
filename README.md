# CalSnap · Custom Calendars for TeamSnap

CalSnap delivers custom team calendar that are more detailed, clear, and usable. CalSnap deploys as a Cloudflare Worker (serverless function), connects to your TeamSnap account, and serves `.ics` iCalendar subscriptions for each team.

“TeamSnap already has calendars! Why use this?”

While TeamSnap supports calendar subscriptions, events lack useful information, team names can be too long, and descriptions are messy.

CalSnap uses the TeamSnap API so that your calendars include:

- a custom team name (shorter or more descriptive)
- links to TeamSnap event pages
- arrival times (minutes early)
- event notes by team manager or coach

<table>
   <tr>
      <td><b>CalSnap Event List</b>
      <td>TeamSnap Event List
   <tr>
      <td>
         Leafs vs. Forest Hill Knights<br />
         Leafs vs. North York Jets<br />
         Leafs vs. East York Lynx
      <td>
         North Toronto Leafs 2014 U12 AAA…<br />
         North Toronto Leafs 2014 U12 AAA…<br />
         North Toronto Leafs 2014 U12 AAA…
</table>

<table>
   <tr>
      <td><b>CalSnap Event Details
      <td>TeamSnap Event Details
   <tr>
      <td>
         Leafs vs. Forest Hill Knights<br />
         GitHub Arena<br />
         101 Command Line Ave.<br />
      <td>
         North Toronto Leafs 2014 U12 AAA…<br />
         101 Command Line Ave.<br />
         &nbsp;
   <tr>
      <td>
         Away at Forest Hill Knights<br />
         Uniform: White<br />
         GitHub Arena<br />
         Rink B<br />
         Arrival: 1:20 PM · 40 min.<br />
         Notes: limited parking<br />
         <a href="https://go.teamsnap.com/12345/schedule/view_event/67890">TeamSnap event page link</a>
      <td>
         Location: GitHub Arena - Rink A<br />
         Uniform: White (Arrival Time: 1:20<br />
         PM (Eastern Time (US & Canada)))<br />
         &nbsp;<br />
         &nbsp;<br />
         &nbsp;<br />
         &nbsp;<br />
</table>

&nbsp;

# Deployment

## step 1. Create Cloudflare Worker

### option A: Cloudflare Dashboard

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/andesco/calsnap)

1. <nobr>Workers & Pages</nobr> ⇢ <nobr>Create an application</nobr> ⇢ <nobr>[Clone a repository](https://dash.cloudflare.com/?to=/:account/workers-and-pages/create/deploy-to-workers)</nobr>
2. Git repository URL:
    ```
    http://github.com/andesco/calsnap
    ```

### option B: Wrangler CLI

1. Create a [Cloudflare Workers KV](https://developers.cloudflare.com/kv/) namespace with Wrangler CLI and note the new namespace ID:
    ```bash
    git clone https://github.com/andesco/calsnap.git
    cd calsnap
    wrangler kv namespace create "CALSNAP_CALENDAR_STORE"
    ```

2. Update `wrangler.toml` with the new KV namespace ID and set your environment variables:
    ```toml wrangler.toml
    [[kv_namespaces]]
    binding = "CALSNAP_CALENDAR_STORE"
    id = "{new KV namespace ID}"
    ```

3. Deploy with Wrangler CLI:
    ```bash
    wrangler deploy
    ```

4.  Note your new worker URL from the output: \
    &nbsp; \
    <nobr>`https://calsnap.`<b>`{subdomain}`</b>`.workers.dev`</nobr>


## step 2. Create TeamSnap Application

1. [TeamSnap authentication](https://auth.teamsnap.com/) ⇢ [Your Account](https://auth.teamsnap.com/) ⇢ [Your Applications](https://auth.teamsnap.com/oauth/applications) ⇢ [New Application](https://auth.teamsnap.com/oauth/applications/new)

2. Name: `TeamSnap Custom Calendar` \
   Description: `Cloudflare Worker` \
   Redirect URI: <nobr>`https://calsnap.`<b>`{subdomain}`</b>`.workers.dev`</nobr>

3. Client ID: `{your Client ID}` \
   Client Secret: `{your Client Secret}`
   
## step 3. Setup Cloudflare Worker

### option a: Cloudflare Dashboard

1. [Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages/) ⇢ `{worker}` ⇢ Settings: <nobr>Variables and Secrets: Add:</nobr>
2.  Type: `Text`\
    Variable name: `TEAMSNAP_CLIENT_ID`\
    Value: `{your Client ID}`
3.  Type: `Secret`\
    Variable name: `TEAMSNAP_CLIENT_SECRET`\
    Value: `{your Client Secret}`

### option b: Wrangler CLI

1. set your environment variables `wrangler.toml`:
    ```toml wrangler.toml
    [vars]
    ALLOWED_USER_EMAIL = "{your TeamSnap email}"
    TEAMSNAP_CLIENT_ID = "{your Client ID}"
    ```
2. Set your secrets with Wrangler CLI:
    ```bash
    wrangler secret put TEAMSNAP_CLIENT_SECRET
    ```
## step 4.

1. Open your Cloudflare Worker in a browser:
<nobr>`https://calsnap.`<b>`{subdomain}`</b>`.workers.dev`</nobr>
2. Authenticate with TeamSnap.

&nbsp;

## Environment Variables

| Required Variable | Type | Description |
|-------------------|------|-------------|
| `ALLOWED_USER_EMAIL` | Text | TeamSnap email address authorized to use this calendar service. Only this user can access the service. |
| `TEAMSNAP_CLIENT_ID` | Text | Client ID from your TeamSnap OAuth application |
| `TEAMSNAP_CLIENT_SECRET` | Secret | Client Secret from your TeamSnap OAuth application. |
