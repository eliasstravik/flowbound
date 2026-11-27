# Security

Flowbound holds keys that cost money and data about people, so a security problem matters. Thank you for telling us.

## Telling us about a problem

Please tell us privately, not in a public issue, pull request or discussion:

- On GitHub: the repo's **Security** tab, then **Report a vulnerability**
  (https://github.com/eliasstravik/flowbound/security/advisories/new). Only the maintainers can read it.

Say what you found, how to make it happen, and what someone could do with it. A short note is fine; you do not need
a full write-up. We answer within a week, tell you what we will do, and say when it is fixed. We are glad to name
you in the fix unless you would rather not.

## Which versions

Only the newest version gets fixes. Update with `npm install flowbound@latest` in your project folder.

## What counts

Anything that lets someone read a saved key, spend money without a person's yes, get past the sign-in when
Flowbound is live, or read or change data they should not. Problems in a data provider or model provider themselves
go to that provider.
