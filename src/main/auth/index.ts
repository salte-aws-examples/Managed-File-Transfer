import {
  DynamoDBClient,
  GetItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

const secrets = new SecretsManagerClient({});
const dynamo = new DynamoDBClient({});

type TransferAuthEvent = {
  username?: string;
  password?: string;
  publicKey?: string;
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
      PublicKeys?: string[];
    };

async function authenticateWithEntra(
  username: string,
  password: string,
  clientId: string,
  carrierId: string,
  partnerId: string,
  transferId: string,
  env: string,
): Promise<boolean> {
  const secretResponse = await secrets.send(
    new GetSecretValueCommand({ SecretId: process.env.ENTRA_CONFIG_SECRET }),
  );
  const { entra_tenant_id, entra_client_id } = JSON.parse(
    secretResponse.SecretString ?? "{}",
  ) as {
    entra_tenant_id?: string;
    entra_client_id?: string;
  };

  if (!entra_tenant_id || !entra_client_id) {
    console.error("Missing entra_tenant_id or entra_client_id in secret");
    return false;
  }

  const scope = `api://${entra_client_id}/.default`;
  const tokenUrl = `https://login.microsoftonline.com/${entra_tenant_id}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: password,
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
    return false;
  }

  const tokenData = (await tokenResponse.json()) as { access_token: string };
  const [, payloadB64] = tokenData.access_token.split(".");
  const jwtPayload = JSON.parse(
    Buffer.from(payloadB64, "base64url").toString(),
  ) as { aud?: string; roles?: string[] };

  if (jwtPayload.aud !== `api://${entra_client_id}`) {
    console.error(`Invalid token audience: ${jwtPayload.aud}`);
    return false;
  }

  // Validate roles claim matches DynamoDB record exactly.
  // Format: mft-<carrierId>.<partnerId>.<transferTypeId>.<env>
  // Neither Entra nor DynamoDB alone is sufficient — both must agree.
  const roleName = jwtPayload.roles?.[0];
  if (!roleName) {
    console.error(`No roles claim in token for ${username}`);
    return false;
  }
  const roleWithoutPrefix = roleName.replace(/^mft-/, "");
  const [roleCarrier, rolePartner, roleTransfer, roleEnv] =
    roleWithoutPrefix.split(".");

  if (
    roleCarrier !== carrierId ||
    rolePartner !== partnerId ||
    roleTransfer !== transferId ||
    roleEnv !== env
  ) {
    console.error(`Role claim mismatch for ${username}: token=${roleName}`);
    return false;
  }

  return true;
}

export const handler = async (
  event: TransferAuthEvent,
  context: LambdaContext,
): Promise<TransferAuthResponse> => {
  const { username, password } = event ?? {};

  try {
    if (!username) {
      console.error("Missing username");
      return {};
    }

    // 1. Look up username in DynamoDB users table.
    const tableResult = await dynamo.send(
      new GetItemCommand({
        TableName: process.env.USERS_TABLE,
        Key: { username: { S: username } },
      }),
    );

    const item = tableResult.Item;
    if (!item) {
      console.error(`Unknown username: ${username}`);
      return {};
    }
    if (item.status.S !== "active") {
      console.error(`Disabled username: ${username}`);
      return {};
    }

    const protocol = item.protocol.S!;
    const carrierId = item.carrierId.S!;
    const partnerId = item.partnerId.S!;
    const transferId = item.transferTypeId.S!;
    const env = item.env.S!;
    const storedKey = item.publicKey?.S;

    const accountId = context.invokedFunctionArn.split(":")[4];
    const bucket = process.env.S3_BUCKET_NAME;

    if (!bucket) {
      console.error("Missing S3_BUCKET_NAME");
      return {};
    }

    const s3Folder = env === "p" ? "production" : "non-production";
    const roleArn = `arn:aws:iam::${accountId}:role/mft-${carrierId}.${partnerId}.${transferId}.${env}`;
    const homeDirectory = `/${bucket}/${s3Folder}/${carrierId}/${partnerId}/${transferId}`;

    // 2. Branch on protocol and credential type:
    //    ftps              → Entra ID (password required)
    //    sftp + publicKey  → return PublicKeys from DynamoDB; Transfer Family validates the key
    //    sftp + no key     → Entra ID (password required)
    if (protocol === "ftps" || (protocol === "sftp" && !storedKey)) {
      if (!password) {
        console.error(`Missing password for ${username}`);
        return {};
      }

      const clientId = item.clientId?.S;
      if (!clientId) {
        console.error(`No Entra client ID stored for ${username}`);
        return {};
      }

      const authenticated = await authenticateWithEntra(
        username,
        password,
        clientId,
        carrierId,
        partnerId,
        transferId,
        env,
      );
      if (!authenticated) {
        return {};
      }

      console.log(`${protocol.toUpperCase()} Entra authenticated: ${username}`);
    } else if (protocol !== "sftp") {
      console.error(`Unsupported protocol: ${protocol}`);
      return {};
    }

    const response: TransferAuthResponse = {
      Role: roleArn,
      HomeDirectoryType: "LOGICAL",
      HomeDirectoryDetails: JSON.stringify([
        { Entry: "/", Target: homeDirectory },
      ]),
    };

    if (storedKey) {
      return { ...response, PublicKeys: [storedKey] };
    }

    return response;
  } catch (err) {
    console.error("Auth Lambda error:", err);
    return {};
  }
};
