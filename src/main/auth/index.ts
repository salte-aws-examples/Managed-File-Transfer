import {
  AttributeValue,
  DynamoDBClient,
  GetItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { logError, logVerbose } from "./logger";
import {
  allowsAllSourceIps,
  resolveAllowedSourceCidrs,
  sourceIpMatchesCidrs,
} from "./sourceIp";

const secrets = new SecretsManagerClient({});
const dynamo = new DynamoDBClient({});

type TransferAuthEvent = {
  username?: string;
  password?: string;
  publicKey?: string;
  protocol?: string;
  serverId?: string;
  sourceIp?: string;
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

function validateSourceIp(
  username: string,
  sourceIp: string | undefined,
  userItem: Record<string, AttributeValue>,
  partnerItem: Record<string, AttributeValue> | undefined,
): boolean {
  const userOverridePresent = userItem.allowedSourceCidrs !== undefined;
  const allowedCidrs = resolveAllowedSourceCidrs(
    userItem.allowedSourceCidrs?.S,
    partnerItem?.allowedSourceCidrs?.S,
    userOverridePresent,
  );

  if (!allowedCidrs) {
    return true;
  }

  if (allowsAllSourceIps(allowedCidrs)) {
    logVerbose("Source IP unrestricted (0.0.0.0/0)", { username, sourceIp });
    return true;
  }

  if (!sourceIp) {
    logError(`Missing sourceIp for ${username}`);
    return false;
  }

  if (!sourceIpMatchesCidrs(sourceIp, allowedCidrs)) {
    logError(`Source IP denied for ${username}: ${sourceIp}`);
    return false;
  }

  logVerbose("Source IP allowed", { username, sourceIp });
  return true;
}

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
    logError("Missing entra_tenant_id or entra_client_id in secret");
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
    logError(`Entra ID auth failed for ${username}: ${tokenResponse.status}`);
    return false;
  }

  const tokenData = (await tokenResponse.json()) as { access_token: string };
  const [, payloadB64] = tokenData.access_token.split(".");
  const jwtPayload = JSON.parse(
    Buffer.from(payloadB64, "base64url").toString(),
  ) as { aud?: string; roles?: string[] };

  if (jwtPayload.aud !== `api://${entra_client_id}`) {
    logError(`Invalid token audience: ${jwtPayload.aud}`);
    return false;
  }

  const roleName = jwtPayload.roles?.[0];
  if (!roleName) {
    logError(`No roles claim in token for ${username}`);
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
    logError(`Role claim mismatch for ${username}: token=${roleName}`);
    return false;
  }

  return true;
}

export const handler = async (
  event: TransferAuthEvent,
  context: LambdaContext,
): Promise<TransferAuthResponse> => {
  const { username, password, protocol, serverId, sourceIp } = event ?? {};

  logVerbose("Auth request received", {
    username,
    protocol,
    serverId,
    sourceIp,
    hasPassword: Boolean(password),
  });

  try {
    if (!username) {
      logError("Missing username");
      return {};
    }

    const tableResult = await dynamo.send(
      new GetItemCommand({
        TableName: process.env.USERS_TABLE,
        Key: { username: { S: username } },
      }),
    );

    const item = tableResult.Item;
    if (!item) {
      logError(`Unknown username: ${username}`);
      return {};
    }
    if (item.status.S !== "active") {
      logError(`Disabled username: ${username}`);
      return {};
    }

    const userProtocol = item.protocol.S!;
    const carrierId = item.carrierId.S!;
    const partnerId = item.partnerId.S!;
    const transferId = item.transferTypeId.S!;
    const env = item.env.S!;
    const storedKey = item.publicKey?.S;

    const partnerResult = await dynamo.send(
      new GetItemCommand({
        TableName: process.env.PARTNERS_TABLE,
        Key: { partnerId: { S: partnerId } },
      }),
    );

    if (!validateSourceIp(username, sourceIp, item, partnerResult.Item)) {
      return {};
    }

    const accountId = context.invokedFunctionArn.split(":")[4];
    const bucket = process.env.S3_BUCKET_NAME;

    if (!bucket) {
      logError("Missing S3_BUCKET_NAME");
      return {};
    }

    const s3Folder = env === "p" ? "production" : "non-production";
    const roleArn = `arn:aws:iam::${accountId}:role/mft-${carrierId}.${partnerId}.${transferId}.${env}`;
    const homeDirectory = `/${bucket}/${s3Folder}/${carrierId}/${partnerId}/${transferId}`;

    if (protocol && protocol.toLowerCase() !== userProtocol.toLowerCase()) {
      logError(
        `Protocol mismatch for ${username}: event=${protocol} record=${userProtocol}`,
      );
      return {};
    }

    if (userProtocol === "ftps" || (userProtocol === "sftp" && !storedKey)) {
      if (!password) {
        logError(`Missing password for ${username}`);
        return {};
      }

      const clientId = item.clientId?.S;
      if (!clientId) {
        logError(`No Entra client ID stored for ${username}`);
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

      logVerbose(`${userProtocol.toUpperCase()} Entra authenticated`, {
        username,
      });
    } else if (userProtocol !== "sftp") {
      logError(`Unsupported protocol: ${userProtocol}`);
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
      logVerbose("SFTP public key session issued", { username });
      return { ...response, PublicKeys: [storedKey] };
    }

    logVerbose("Session issued", { username, protocol: userProtocol });
    return response;
  } catch (err) {
    logError(`Auth Lambda error: ${String(err)}`);
    return {};
  }
};
