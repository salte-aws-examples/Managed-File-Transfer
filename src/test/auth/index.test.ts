const mockDynamoSend = jest.fn();

jest.mock("@aws-sdk/client-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/client-dynamodb");
  return {
    ...actual,
    DynamoDBClient: jest.fn().mockImplementation(() => ({
      send: mockDynamoSend,
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

function mockDynamoLookups(
  userItem: Record<string, { S: string }>,
  partnerItem?: Record<string, { S: string }>,
) {
  mockDynamoSend.mockImplementation((command: { input: { TableName: string } }) => {
    if (command.input.TableName === process.env.USERS_TABLE) {
      return Promise.resolve({ Item: userItem });
    }
    if (command.input.TableName === process.env.PARTNERS_TABLE) {
      return Promise.resolve({ Item: partnerItem });
    }
    return Promise.resolve({});
  });
}

describe("auth lambda", () => {
  const invokedFunctionArn =
    "arn:aws:lambda:us-east-1:123456789012:function:salte-mft-auth";

  beforeEach(() => {
    jest.clearAllMocks();
    mockDynamoSend.mockReset();
    delete process.env.VERBOSE_LOGGING;
    process.env.ENTRA_CONFIG_SECRET = "salte/mft/entra";
    process.env.S3_BUCKET_NAME = "bucket-name";
    process.env.USERS_TABLE = "salte-mft-users";
    process.env.PARTNERS_TABLE = "salte-mft-partners";

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
    let handler!: typeof import("../../main/auth").handler;
    jest.isolateModules(() => {
      handler = require("../../main/auth").handler;
    });

    mockDynamoLookups(
      {
        status: { S: "active" },
        protocol: { S: "sftp" },
        carrierId: { S: "sample-carrier" },
        partnerId: { S: "sample-partner" },
        transferTypeId: { S: "sample-transfer-2" },
        env: { S: "np" },
        publicKey: { S: "ssh-rsa AAAA test-key" },
      },
      {
        partnerId: { S: "sample-partner" },
        allowedSourceCidrs: { S: '["0.0.0.0/0"]' },
      },
    );

    const res = await handler(
      {
        username: "sample-sftp-test",
        sourceIp: "203.0.113.42",
        protocol: "SFTP",
      },
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

  test("denies before Entra when partner CIDR does not match source IP", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    let handler!: typeof import("../../main/auth").handler;
    jest.isolateModules(() => {
      handler = require("../../main/auth").handler;
    });

    mockDynamoLookups(
      {
        status: { S: "active" },
        protocol: { S: "ftps" },
        carrierId: { S: "sample-carrier" },
        partnerId: { S: "sample-partner" },
        transferTypeId: { S: "sample-transfer-1" },
        env: { S: "np" },
        clientId: { S: "partner-entra-client-id" },
      },
      {
        partnerId: { S: "sample-partner" },
        allowedSourceCidrs: { S: '["203.0.113.0/24"]' },
      },
    );

    const res = await handler(
      {
        username: "sample-ftps-test",
        password: "partner-secret",
        sourceIp: "198.51.100.42",
        protocol: "FTPS",
      },
      { invokedFunctionArn },
    );

    expect(res).toEqual({});
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  test("uses transfer-level CIDR override instead of partner defaults", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    let handler!: typeof import("../../main/auth").handler;
    jest.isolateModules(() => {
      handler = require("../../main/auth").handler;
    });

    mockDynamoLookups(
      {
        status: { S: "active" },
        protocol: { S: "sftp" },
        carrierId: { S: "sample-carrier" },
        partnerId: { S: "sample-partner" },
        transferTypeId: { S: "sample-transfer-2" },
        env: { S: "np" },
        publicKey: { S: "ssh-rsa AAAA test-key" },
        allowedSourceCidrs: { S: '["198.51.100.42/32"]' },
      },
      {
        partnerId: { S: "sample-partner" },
        allowedSourceCidrs: { S: '["203.0.113.0/24"]' },
      },
    );

    const allowed = await handler(
      {
        username: "sample-sftp-test",
        sourceIp: "198.51.100.42",
        protocol: "SFTP",
      },
      { invokedFunctionArn },
    );
    expect(allowed).not.toEqual({});

    const denied = await handler(
      {
        username: "sample-sftp-test",
        sourceIp: "203.0.113.42",
        protocol: "SFTP",
      },
      { invokedFunctionArn },
    );
    expect(denied).toEqual({});
  });

  test("FTPS uses DynamoDB clientId for Entra token request", async () => {
    const { SecretsManagerClient } = jest.requireMock(
      "@aws-sdk/client-secrets-manager",
    );
    let handler!: typeof import("../../main/auth").handler;
    jest.isolateModules(() => {
      handler = require("../../main/auth").handler;
    });

    const secretsClientInstance = SecretsManagerClient.mock.results[0]?.value;

    mockDynamoLookups(
      {
        status: { S: "active" },
        protocol: { S: "ftps" },
        carrierId: { S: "sample-carrier" },
        partnerId: { S: "sample-partner" },
        transferTypeId: { S: "sample-transfer-1" },
        env: { S: "np" },
        clientId: { S: "partner-entra-client-id" },
      },
      {
        partnerId: { S: "sample-partner" },
        allowedSourceCidrs: { S: '["0.0.0.0/0"]' },
      },
    );

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
        sourceIp: "203.0.113.42",
        protocol: "FTPS",
      },
      { invokedFunctionArn },
    );

    const fetchBody = (global as any).fetch.mock.calls[0][1].body as string;
    expect(fetchBody).toContain("client_id=partner-entra-client-id");

    expect(res).toEqual(sessionBase);
  });

  test("SFTP without stored publicKey uses Entra with DynamoDB clientId", async () => {
    const { SecretsManagerClient } = jest.requireMock(
      "@aws-sdk/client-secrets-manager",
    );
    let handler!: typeof import("../../main/auth").handler;
    jest.isolateModules(() => {
      handler = require("../../main/auth").handler;
    });

    const secretsClientInstance = SecretsManagerClient.mock.results[0]?.value;

    mockDynamoLookups(
      {
        status: { S: "active" },
        protocol: { S: "sftp" },
        carrierId: { S: "sample-carrier" },
        partnerId: { S: "sample-partner" },
        transferTypeId: { S: "sample-transfer-3" },
        env: { S: "np" },
        clientId: { S: "sftp-entra-client-id" },
      },
      {
        partnerId: { S: "sample-partner" },
        allowedSourceCidrs: { S: '["0.0.0.0/0"]' },
      },
    );

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
        sourceIp: "10.0.0.5",
        protocol: "SFTP",
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
    let handler!: typeof import("../../main/auth").handler;
    jest.isolateModules(() => {
      handler = require("../../main/auth").handler;
    });

    mockDynamoLookups(
      {
        status: { S: "disabled" },
        protocol: { S: "ftps" },
        carrierId: { S: "sample-carrier" },
        partnerId: { S: "sample-partner" },
        transferTypeId: { S: "sample-transfer-1" },
        env: { S: "np" },
        clientId: { S: "partner-entra-client-id" },
      },
      {
        partnerId: { S: "sample-partner" },
        allowedSourceCidrs: { S: '["0.0.0.0/0"]' },
      },
    );

    const res = await handler(
      {
        username: "sample-ftps-test",
        password: "partner-secret",
        sourceIp: "203.0.113.42",
      },
      { invokedFunctionArn },
    );

    expect(res).toEqual({});
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  test("FTPS denies when Entra role claim does not match DynamoDB record", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    const { SecretsManagerClient } = jest.requireMock(
      "@aws-sdk/client-secrets-manager",
    );
    let handler!: typeof import("../../main/auth").handler;
    jest.isolateModules(() => {
      handler = require("../../main/auth").handler;
    });

    const secretsClientInstance = SecretsManagerClient.mock.results[0]?.value;

    mockDynamoLookups(
      {
        status: { S: "active" },
        protocol: { S: "ftps" },
        carrierId: { S: "sample-carrier" },
        partnerId: { S: "sample-partner" },
        transferTypeId: { S: "sample-transfer-1" },
        env: { S: "np" },
        clientId: { S: "partner-entra-client-id" },
      },
      {
        partnerId: { S: "sample-partner" },
        allowedSourceCidrs: { S: '["0.0.0.0/0"]' },
      },
    );

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
        sourceIp: "203.0.113.42",
      },
      { invokedFunctionArn },
    );

    expect(res).toEqual({});
  });

  test("FTPS denies when password is missing", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    let handler!: typeof import("../../main/auth").handler;
    jest.isolateModules(() => {
      handler = require("../../main/auth").handler;
    });

    mockDynamoLookups(
      {
        status: { S: "active" },
        protocol: { S: "ftps" },
        carrierId: { S: "sample-carrier" },
        partnerId: { S: "sample-partner" },
        transferTypeId: { S: "sample-transfer-1" },
        env: { S: "np" },
        clientId: { S: "partner-entra-client-id" },
      },
      {
        partnerId: { S: "sample-partner" },
        allowedSourceCidrs: { S: '["0.0.0.0/0"]' },
      },
    );

    const res = await handler(
      {
        username: "sample-ftps-test",
        sourceIp: "203.0.113.42",
      },
      { invokedFunctionArn },
    );

    expect(res).toEqual({});
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  test("logs verbose request details when VERBOSE_LOGGING is enabled", async () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    process.env.VERBOSE_LOGGING = "true";

    let handler!: typeof import("../../main/auth").handler;
    jest.isolateModules(() => {
      handler = require("../../main/auth").handler;
    });

    mockDynamoLookups(
      {
        status: { S: "disabled" },
        protocol: { S: "ftps" },
        carrierId: { S: "sample-carrier" },
        partnerId: { S: "sample-partner" },
        transferTypeId: { S: "sample-transfer-1" },
        env: { S: "np" },
      },
      {
        partnerId: { S: "sample-partner" },
        allowedSourceCidrs: { S: '["0.0.0.0/0"]' },
      },
    );

    await handler(
      {
        username: "sample-ftps-test",
        password: "secret",
        sourceIp: "203.0.113.42",
        protocol: "FTPS",
        serverId: "s-abc123",
      },
      { invokedFunctionArn },
    );

    expect(logSpy).toHaveBeenCalledWith(
      "Auth request received",
      JSON.stringify({
        username: "sample-ftps-test",
        protocol: "FTPS",
        serverId: "s-abc123",
        sourceIp: "203.0.113.42",
        hasPassword: true,
      }),
    );
  });
});
