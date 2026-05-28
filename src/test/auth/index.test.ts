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

describe("auth lambda", () => {
  const invokedFunctionArn =
    "arn:aws:lambda:us-east-1:123456789012:function:salte-mft-auth";

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENTRA_CONFIG_SECRET = "salte/mft/entra";
    process.env.S3_BUCKET_NAME = "bucket-name";

    (global as any).fetch = jest.fn();
  });

  test("returns {} when missing username/password", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    let handler!: typeof import("../../main/auth").handler;
    jest.isolateModules(() => {
      handler = require("../../main/auth").handler;
    });
    const res1 = await handler({}, { invokedFunctionArn });
    const res2 = await handler({ username: "u" }, { invokedFunctionArn });

    expect(res1).toEqual({});
    expect(res2).toEqual({});
  });

  test("parses dot-delimited role name; preserves hyphens", async () => {
    const { SecretsManagerClient } = jest.requireMock(
      "@aws-sdk/client-secrets-manager",
    );
    let handler!: typeof import("../../main/auth").handler;
    jest.isolateModules(() => {
      handler = require("../../main/auth").handler;
    });

    const secretsClientInstance = SecretsManagerClient.mock.results[0]?.value;
    expect(secretsClientInstance).toBeTruthy();

    secretsClientInstance.send.mockResolvedValue({
      SecretString: JSON.stringify({
        entra_tenant_id: "tenant",
        entra_client_id: "lambda-client-id",
        entra_client_secret: "ignored",
      }),
    });

    const access_token = jwt({
      aud: "api://lambda-client-id",
      roles: ["mft-sample-carrier.sample-partner.sample-transfer.np"],
    });

    (global as any).fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token }),
    });

    const res = await handler(
      { username: "partner-guid", password: "partner-secret" },
      { invokedFunctionArn },
    );

    expect(res).toEqual({
      Role: "arn:aws:iam::123456789012:role/mft-sample-carrier.sample-partner.sample-transfer.np",
      HomeDirectoryType: "LOGICAL",
      HomeDirectoryDetails: JSON.stringify([
        {
          Entry: "/",
          Target:
            "/bucket-name/non-production/sample-carrier/sample-partner/sample-transfer",
        },
      ]),
    });
  });
});

