# Wallet Assets

This directory contains assets required for Apple Wallet pass generation.

## Required Files

When Apple Wallet integration is configured, place these files here:

- `icon.png` (29x29) - App icon for the pass
- `icon@2x.png` (58x58) - Retina app icon
- `logo.png` (160x50) - Logo displayed on the pass
- `logo@2x.png` (320x100) - Retina logo

## Configuration

Set the following environment variables in `.env`:

```
APPLE_PASS_TYPE_ID=pass.com.wafi.loyalty
APPLE_TEAM_ID=YOUR_TEAM_ID
APPLE_PASS_CERT_PATH=./certs/apple-pass.pem
APPLE_PASS_CERT_KEY_PATH=./certs/apple-pass-key.pem
APPLE_WWDR_CERT_PATH=./certs/wwdr.pem

GOOGLE_WALLET_ISSUER_ID=YOUR_ISSUER_ID
GOOGLE_WALLET_CLASS_SUFFIX=wafi_loyalty
GOOGLE_WALLET_SERVICE_ACCOUNT_KEY_PATH=./certs/google-wallet-sa.json
```
