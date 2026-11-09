/**
 * Bundled Google OAuth client, used when the user has not configured their own.
 *
 * MAINTAINER: to make first-run login work out of the box, create one OAuth
 * client in Google Cloud Console (APIs & Services → Credentials → Create
 * Credentials → OAuth client ID → Application type: Desktop app) and paste
 * its id and secret below. Installed-app secrets ship inside distributed CLIs
 * as a matter of course (the app type is public); the user can still override
 * with GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET env vars or oauth.env, which win
 * over these values. Until this is filled in, `ccm` prints setup steps instead.
 */
export const DEFAULT_OAUTH = { clientId: "", clientSecret: "" };
