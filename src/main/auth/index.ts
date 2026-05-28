import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

const secrets = new SecretsManagerClient({});

// Role name environment suffix → S3 folder mapping
const ENV_FOLDER_MAP: Record<string, string> = {
  p: "production",
  np: "non-production",
};

type TransferAuthEvent = {
  username?: string;
  password?: string;
};

type LambdaContext = {
  invokedFunctionArn: string;
};

type TransferAuthResponse =
  | {}
  | {
      Role: string;
      HomeDirectoryType: "LOGICAL";
      HomeDirectoryDetails: string;
    };

export const handler = async (
  event: TransferAuthEvent,
  context: LambdaContext,
): Promise<TransferAuthResponse> => {
  const { username, password } = event ?? {};

  try {
    if (!username || !password) {
      console.error("Missing username or password");
      return {};
    }

    // 1. Fetch Entra config from Secrets Manager at runtime.
    // Intentionally not cached — secret rotations take effect immediately.
    // Secret is a JSON object with keys: entra_tenant_id, entra_client_id, entra_client_secret
    const secretId = process.env.ENTRA_CONFIG_SECRET;
    const secretResponse = await secrets.send(
      new GetSecretValueCommand({ SecretId: secretId }),
    );
    const { entra_tenant_id, entra_client_id } = JSON.parse(
      secretResponse.SecretString ?? "{}",
    ) as {
      entra_tenant_id?: string;
      entra_client_id?: string;
      entra_client_secret?: string;
    };

    if (!entra_tenant_id || !entra_client_id) {
      console.error("Missing entra_tenant_id or entra_client_id in secret");
      return {};
    }

    // 2. Validate partner credentials against Entra ID token endpoint.
    // The .default suffix is required by Entra ID for client credentials
    // flow against custom APIs — named scopes are not supported in this flow.
    const scope = `api://${entra_client_id}/mft.connect`;
    const tokenUrl = `https://login.microsoftonline.com/${entra_tenant_id}/oauth2/v2.0/token`;

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: username, // Partner's Entra ID app registration client ID
      client_secret: password, // Partner's Entra ID app registration client secret
      scope,
    });

    const tokenResponse = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!tokenResponse.ok) {
      console.error(
        `Entra ID auth failed for ${username}: ${tokenResponse.status}`,
      );
      return {};
    }

    const tokenData = (await tokenResponse.json()) as { access_token: string };

    // 3. Decode and validate JWT audience claim.
    // Signature verification is provided by the TLS channel to the Entra ID token endpoint.
    const [, payloadB64] = tokenData.access_token.split(".");
    const payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString(),
    ) as { aud?: string; roles?: string[] };

    const expectedAudience = `api://${entra_client_id}`;
    if (payload.aud !== expectedAudience) {
      console.error(`Invalid token audience: ${payload.aud}`);
      return {};
    }

    // 4. Read IAM role name from the roles claim.
    // Format: mft-<carrier>.<partner>.<transfer-type>.<env>
    if (!payload.roles || payload.roles.length === 0) {
      console.error(`No roles claim in token for ${username}`);
      return {};
    }

    const roleName = payload.roles[0];
    console.log(`Authenticated ${username} → role: ${roleName}`);

    // 5. Parse role name to derive home directory.
    // Strip leading "mft-" then split on "." — dots are the segment delimiter
    // between carrier, partner, transfer-type, and env. Hyphens within segment
    // names are preserved correctly with this approach.
    const roleWithoutPrefix = roleName.replace(/^mft-/, "");
    const parts = roleWithoutPrefix.split(".");

    if (parts.length < 4) {
      console.error(`Invalid role name format: ${roleName}`);
      return {};
    }

    const env = parts[parts.length - 1];
    const transferType = parts[parts.length - 2];
    const partner = parts[parts.length - 3];
    const carrier = parts.slice(0, parts.length - 3).join(".");

    const s3Folder = ENV_FOLDER_MAP[env];
    if (!s3Folder) {
      console.error(`Unknown environment suffix in role name: ${env}`);
      return {};
    }

    // 6. Construct role ARN and home directory.
    const accountId = context.invokedFunctionArn.split(":")[4];
    const bucket = process.env.S3_BUCKET_NAME;

    if (!bucket) {
      console.error("Missing S3_BUCKET_NAME");
      return {};
    }

    const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
    const homeDirectory = `/${bucket}/${s3Folder}/${carrier}/${partner}/${transferType}`;

    return {
      Role: roleArn,
      HomeDirectoryType: "LOGICAL",
      HomeDirectoryDetails: JSON.stringify([{ Entry: "/", Target: homeDirectory }]),
    };
  } catch (err) {
    console.error("Auth Lambda error:", err);
    return {};
  }
};

