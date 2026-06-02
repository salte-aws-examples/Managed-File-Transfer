jest.mock("@aws-sdk/client-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/client-dynamodb");
  return {
    ...actual,
    DynamoDBClient: jest.fn().mockImplementation(() => ({
      send: jest.fn(),
    })),
    GetItemCommand: actual.GetItemCommand,
  };
});

jest.mock("@aws-sdk/client-secrets-manager", () => {
  const actual = jest.requireActual("@aws-sdk/client-secrets-manager");
  return {
    ...actual,
    SecretsManagerClient: jest.fn().mockImplementation(() => ({
      send: jest.fn(),
    })),
    GetSecretValueCommand: actual.GetSecretValueCommand,
  };
});

function jwt(payload: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

const sessionBase = {
  Role: "arn:aws:iam::123456789012:role/mft-sample-carrier.sample-partner.sample-transfer-1.np",
  HomeDirectoryType: "LOGICAL" as const,
  HomeDirectoryDetails: JSON.stringify([
    {
      Entry: "/",
      Target:
        "/bucket-name/non-production/sample-carrier/sample-partner/sample-transfer-1",
    },
  ]),
};

describe("auth lambda", () => {
  const invokedFunctionArn =
    "arn:aws:lambda:us-east-1:123456789012:function:salte-mft-auth";

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENTRA_CONFIG_SECRET = "salte/mft/entra";
    process.env.S3_BUCKET_NAME = "bucket-name";
    process.env.USERS_TABLE = "salte-mft-users";

    (global as any).fetch = jest.fn();
  });

  test("returns {} when missing username", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    let handler!: typeof import("../../main/auth").handler;
    jest.isolateModules(() => {
      handler = require("../../main/auth").handler;
    });

    const res = await handler({}, { invokedFunctionArn });
    expect(res).toEqual({});
  });

  test("SFTP with stored publicKey returns PublicKeys from DynamoDB without password", async () => {
    const { DynamoDBClient } = jest.requireMock("@aws-sdk/client-dynamodb");
    let handler!: typeof import("../../main/auth").handler;
    jest.isolateModules(() => {
      handler = require("../../main/auth").handler;
    });

    const dynamoClientInstance = DynamoDBClient.mock.results[0]?.value;
    dynamoClientInstance.send.mockResolvedValue({
      Item: {
        status: { S: "active" },
        protocol: { S: "sftp" },
        carrierId: { S: "sample-carrier" },
        partnerId: { S: "sample-partner" },
        transferTypeId: { S: "sample-transfer-2" },
        env: { S: "np" },
        publicKey: { S: "ssh-rsa AAAA test-key" },
      },
    });

    const res = await handler(
      { username: "sample-sftp-test" },
      { invokedFunctionArn },
    );

    expect(res).toEqual({
      Role: "arn:aws:iam::123456789012:role/mft-sample-carrier.sample-partner.sample-transfer-2.np",
      HomeDirectoryType: "LOGICAL",
      HomeDirectoryDetails: JSON.stringify([
        {
          Entry: "/",
          Target:
            "/bucket-name/non-production/sample-carrier/sample-partner/sample-transfer-2",
        },
      ]),
      PublicKeys: ["ssh-rsa AAAA test-key"],
    });
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  test("FTPS uses DynamoDB clientId for Entra token request", async () => {
    const { DynamoDBClient } = jest.requireMock("@aws-sdk/client-dynamodb");
    const { SecretsManagerClient } = jest.requireMock(
      "@aws-sdk/client-secrets-manager",
    );
    let handler!: typeof import("../../main/auth").handler;
    jest.isolateModules(() => {
      handler = require("../../main/auth").handler;
    });

    const dynamoClientInstance = DynamoDBClient.mock.results[0]?.value;
    const secretsClientInstance = SecretsManagerClient.mock.results[0]?.value;

    dynamoClientInstance.send.mockResolvedValue({
      Item: {
        status: { S: "active" },
        protocol: { S: "ftps" },
        carrierId: { S: "sample-carrier" },
        partnerId: { S: "sample-partner" },
        transferTypeId: { S: "sample-transfer-1" },
        env: { S: "np" },
        clientId: { S: "partner-entra-client-id" },
      },
    });

    secretsClientInstance.send.mockResolvedValue({
      SecretString: JSON.stringify({
        entra_tenant_id: "tenant",
        entra_client_id: "lambda-client-id",
      }),
    });

    const access_token = jwt({
      aud: "api://lambda-client-id",
      roles: ["mft-sample-carrier.sample-partner.sample-transfer-1.np"],
    });

    (global as any).fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token }),
    });

    const res = await handler(
      {
        username: "sample-ftps-test",
        password: "partner-secret",
      },
      { invokedFunctionArn },
    );

    const fetchBody = (global as any).fetch.mock.calls[0][1].body as string;
    expect(fetchBody).toContain("client_id=partner-entra-client-id");

    expect(res).toEqual(sessionBase);
  });

  test("SFTP without stored publicKey uses Entra with DynamoDB clientId", async () => {
    const { DynamoDBClient } = jest.requireMock("@aws-sdk/client-dynamodb");
    const { SecretsManagerClient } = jest.requireMock(
      "@aws-sdk/client-secrets-manager",
    );
    let handler!: typeof import("../../main/auth").handler;
    jest.isolateModules(() => {
      handler = require("../../main/auth").handler;
    });

    const dynamoClientInstance = DynamoDBClient.mock.results[0]?.value;
    const secretsClientInstance = SecretsManagerClient.mock.results[0]?.value;

    dynamoClientInstance.send.mockResolvedValue({
      Item: {
        status: { S: "active" },
        protocol: { S: "sftp" },
        carrierId: { S: "sample-carrier" },
        partnerId: { S: "sample-partner" },
        transferTypeId: { S: "sample-transfer-3" },
        env: { S: "np" },
        clientId: { S: "sftp-entra-client-id" },
      },
    });

    secretsClientInstance.send.mockResolvedValue({
      SecretString: JSON.stringify({
        entra_tenant_id: "tenant",
        entra_client_id: "lambda-client-id",
      }),
    });

    const access_token = jwt({
      aud: "api://lambda-client-id",
      roles: ["mft-sample-carrier.sample-partner.sample-transfer-3.np"],
    });

    (global as any).fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token }),
    });

    const res = await handler(
      {
        username: "sample-sftp-entra-test",
        password: "partner-secret",
      },
      { invokedFunctionArn },
    );

    const fetchBody = (global as any).fetch.mock.calls[0][1].body as string;
    expect(fetchBody).toContain("client_id=sftp-entra-client-id");

    expect(res).toEqual({
      Role: "arn:aws:iam::123456789012:role/mft-sample-carrier.sample-partner.sample-transfer-3.np",
      HomeDirectoryType: "LOGICAL",
      HomeDirectoryDetails: JSON.stringify([
        {
          Entry: "/",
          Target:
            "/bucket-name/non-production/sample-carrier/sample-partner/sample-transfer-3",
        },
      ]),
    });
  });

  test("denies inactive user before credential validation", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    const { DynamoDBClient } = jest.requireMock("@aws-sdk/client-dynamodb");
    let handler!: typeof import("../../main/auth").handler;
    jest.isolateModules(() => {
      handler = require("../../main/auth").handler;
    });

    const dynamoClientInstance = DynamoDBClient.mock.results[0]?.value;
    dynamoClientInstance.send.mockResolvedValue({
      Item: {
        status: { S: "disabled" },
        protocol: { S: "ftps" },
        carrierId: { S: "sample-carrier" },
        partnerId: { S: "sample-partner" },
        transferTypeId: { S: "sample-transfer-1" },
        env: { S: "np" },
        clientId: { S: "partner-entra-client-id" },
      },
    });

    const res = await handler(
      {
        username: "sample-ftps-test",
        password: "partner-secret",
      },
      { invokedFunctionArn },
    );

    expect(res).toEqual({});
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  test("FTPS denies when Entra role claim does not match DynamoDB record", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    const { DynamoDBClient } = jest.requireMock("@aws-sdk/client-dynamodb");
    const { SecretsManagerClient } = jest.requireMock(
      "@aws-sdk/client-secrets-manager",
    );
    let handler!: typeof import("../../main/auth").handler;
    jest.isolateModules(() => {
      handler = require("../../main/auth").handler;
    });

    const dynamoClientInstance = DynamoDBClient.mock.results[0]?.value;
    const secretsClientInstance = SecretsManagerClient.mock.results[0]?.value;

    dynamoClientInstance.send.mockResolvedValue({
      Item: {
        status: { S: "active" },
        protocol: { S: "ftps" },
        carrierId: { S: "sample-carrier" },
        partnerId: { S: "sample-partner" },
        transferTypeId: { S: "sample-transfer-1" },
        env: { S: "np" },
        clientId: { S: "partner-entra-client-id" },
      },
    });

    secretsClientInstance.send.mockResolvedValue({
      SecretString: JSON.stringify({
        entra_tenant_id: "tenant",
        entra_client_id: "lambda-client-id",
      }),
    });

    const access_token = jwt({
      aud: "api://lambda-client-id",
      roles: ["mft-other-carrier.sample-partner.sample-transfer-1.np"],
    });

    (global as any).fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token }),
    });

    const res = await handler(
      {
        username: "sample-ftps-test",
        password: "partner-secret",
      },
      { invokedFunctionArn },
    );

    expect(res).toEqual({});
  });

  test("FTPS denies when password is missing", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    const { DynamoDBClient } = jest.requireMock("@aws-sdk/client-dynamodb");
    let handler!: typeof import("../../main/auth").handler;
    jest.isolateModules(() => {
      handler = require("../../main/auth").handler;
    });

    const dynamoClientInstance = DynamoDBClient.mock.results[0]?.value;
    dynamoClientInstance.send.mockResolvedValue({
      Item: {
        status: { S: "active" },
        protocol: { S: "ftps" },
        carrierId: { S: "sample-carrier" },
        partnerId: { S: "sample-partner" },
        transferTypeId: { S: "sample-transfer-1" },
        env: { S: "np" },
        clientId: { S: "partner-entra-client-id" },
      },
    });

    const res = await handler(
      { username: "sample-ftps-test" },
      { invokedFunctionArn },
    );

    expect(res).toEqual({});
    expect((global as any).fetch).not.toHaveBeenCalled();
  });
});
