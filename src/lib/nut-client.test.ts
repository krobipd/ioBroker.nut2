import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";
import { authFailureText, isTlsConfigError, MAX_LINE_BYTES, NutClient, NutError, NutTimeoutError } from "./nut-client";

// Throwaway self-signed cert+key (CN=localhost, 10y) for the STARTTLS handshake test only.
// The client connects with tlsRejectUnauthorized:false, so a self-signed cert is accepted.
const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUSb0Y7CbK2c7r0L6mI3/N3bRpuvEwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDkwMjEzNDI1OFoXDTM2MDgz
MDEzNDI1OFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAv6P7GdSYNz0BnvdDwjGGPT5qXY7oUDgCJp/jg00i8MEs
rPJUj4Bwc7D3xH/SXGB5h+9tYuwn1AGMhTfhZ2al8G1USZqBu48ZGX6U5fjC1UVl
q3cSr7TGn4eD6lNbMx/pZEED/Ts3Fe8d6twXhcOp8fP+l3Ko44c5KoLd44hIW2EK
4dZuXeNNQSVT/t1pa70nsB3jEWZiV2BkBXRh1EN11aVcxoZ5fZ7a5YwOGBaj6v9d
seT4gylwAR6MLCPdAhNixo3BPOAYZIrSdGlmmwixtCiqk5MnoemyF7X6YJbL6prt
QebzaoAT+Vfm+ExbAeZpSm9ytMHA5Mo7zwAvVJ7lqQIDAQABo28wbTAdBgNVHQ4E
FgQUhcxR/OaidvDau3TwE/PPQQ7bV6kwHwYDVR0jBBgwFoAUhcxR/OaidvDau3Tw
E/PPQQ7bV6kwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBAFPMWpEmM5tJvnBEzG/0ve/21lcPbg21
bfZlDz9rr0xiO2P6fSpR286SbhvtAdwPDhRHxbyOW71jhBpZeCou0IslGQM7M/r/
AsSWA4MsSZXS6nAt5tCYqDO9TBhK+opUWlkCl/tGJkg0BuN8VNM8CmOdfqU3TbR+
lHoHKGgcTiS8ahtnMdAGuvEKaFgG9NwhTd5As942vq24Y6zAxmXgia9fSk1z0zfY
0UlauHccf/MW8/0GgC1IlWsDowcj/LTJtT9w6+ZB7MTUKLtYFHrpUSSBNX53FoA9
nxRGbsxqAMDf5pcCjYmoiFZyk3Wo09yj9rX7Hs+0YhwOnHv3ugAHFB8=
-----END CERTIFICATE-----`;

const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC/o/sZ1Jg3PQGe
90PCMYY9PmpdjuhQOAImn+ODTSLwwSys8lSPgHBzsPfEf9JcYHmH721i7CfUAYyF
N+FnZqXwbVRJmoG7jxkZfpTl+MLVRWWrdxKvtMafh4PqU1szH+lkQQP9OzcV7x3q
3BeFw6nx8/6Xcqjjhzkqgt3jiEhbYQrh1m5d401BJVP+3WlrvSewHeMRZmJXYGQF
dGHUQ3XVpVzGhnl9ntrljA4YFqPq/12x5PiDKXABHowsI90CE2LGjcE84BhkitJ0
aWabCLG0KKqTkyeh6bIXtfpglsvqmu1B5vNqgBP5V+b4TFsB5mlKb3K0wcDkyjvP
AC9UnuWpAgMBAAECggEABdtzvzccdnzxzP0Qaagv8TTBNWSHn+LXJZbEi+/1j3qz
/4HOySEH+6OiLjPchwn3noqk/JcS447iXHSYBs9GgJny1gB3+R0EGFLVjbU9jTbe
oK/WI7koffOhueDib3MilyrjV1/+zJFfO0OohpdznQT6WDO/F88ulXV9y/VcUso2
BB5g7zKiqz7bYdwvOOHOe2Bv96GiN6PnCRBFJIpB1iK0dYXL9Iqgp3KUT84nJH8D
z3YBOHcdjdSZCwMzf5NB2ZYzPtn/HAuz/TYjG6BsS6wZtI3r09L109J0j3dwTmua
AHaASEYe6PK3yT0Gr760sd0v7Zz/Ev8u9DitpFLrNQKBgQD64X7m/rOTk2vJMc+k
kWPjW0873zT9TlWcUs/TrN4p84Hqds5i911evJs/Ej4WX4jQlF/3JAT5kTBcKxs5
w2B5d2B8KCpRENmCyqFmOWPWlrlY7iOX+Tm54HIm+hBRn5Lv6ltt5w5686OfnMee
jXde8A/FE/Ukkxl9F+H+oVE9lQKBgQDDjQltPRrLirPvM9bB7JBKp0O+FWRWg3u2
NkgGCkgdeMvUlwo8z1mINxJWUBlK+KIc3f+cdEU5F1/AizyM+/o+GJDRy0l86dR9
0XLXrHnuAvXk6LckB0pQL7bAF71uVFJWYCO4BnTTrrKEXUzBHFHLJp8SEE5ag1xj
Gp9zW1v6xQKBgDo7lSUxAaXDlkVBFp1wUes4CpAvIzGYuS5r2mmbuoWqTAGMSiOW
n0maJb7iER9IVY10o0HOTolPNhZuuwcRXpdTKkYnXIssihBd0FDWCWKJ4cPOotxn
sQqAGn8JlDgd/hFKKKa99xJ68wPddEhNNeQHfOGV3FT8//GVVZOxBhZxAoGAbf7n
TosQh219yQ9fvbVTdKqhcEqYJhHPhK8D1GH0Lp/EB9Dt8UaxFe3kYqirkYBJr/Mv
1NGSHosHUUcAyEz0dflbfKbcr2bYH+2wq6BY9Yi0yA4e9iUjp/cu1N6Fr4m+xtdN
QDZhgLDDubDBe95yI9OVppOFf2Rkk1pmVn0NQAECgYEAmJDZRi7T3b5XOVDgdKFY
xkS9u1yCbpaDzGcyPFhiynlbZ+esuw/gpqCkQGe+rYnpdPEHxWqUp7vQEMC0p5jO
r5D54skfkyxwXWG5bDaIybPwDo4X/2ULCuJ7N1R9Pf8pl/+PYVOqoSGU07X/mHP9
NOrvKUxEDG11lxm5tG7mB+8=
-----END PRIVATE KEY-----`;

// ---------------------------------------------------------------------------
// Mock NUT TCP Server
// ---------------------------------------------------------------------------

interface MockHandler {
  (command: string): string | string[] | null;
}

function createMockNutServer(handler?: MockHandler): {
  server: net.Server;
  start: () => Promise<number>;
  stop: () => Promise<void>;
  disconnectAll: () => void;
  port: number;
  commands: string[];
} {
  const commands: string[] = [];
  const connections = new Set<net.Socket>();
  let port = 0;

  const defaultHandler: MockHandler = (cmd: string): string | string[] | null => {
    if (cmd === "LIST UPS") {
      return ["BEGIN LIST UPS", 'UPS ups0 "Main UPS"', 'UPS ups1 "Backup UPS"', "END LIST UPS"];
    }
    if (cmd.startsWith("LIST VAR ")) {
      const ups = cmd.split(" ")[2];
      return [
        `BEGIN LIST VAR ${ups}`,
        `VAR ${ups} battery.charge "100"`,
        `VAR ${ups} ups.status "OL"`,
        `VAR ${ups} ups.load "15"`,
        `END LIST VAR ${ups}`,
      ];
    }
    if (cmd.startsWith("LIST RW ")) {
      const ups = cmd.split(" ")[2];
      return [`BEGIN LIST RW ${ups}`, `RW ${ups} ups.delay.shutdown "20"`, `END LIST RW ${ups}`];
    }
    if (cmd.startsWith("LIST CMD ")) {
      const ups = cmd.split(" ")[2];
      return [`BEGIN LIST CMD ${ups}`, `CMD ${ups} beeper.enable`, `CMD ${ups} load.off`, `END LIST CMD ${ups}`];
    }
    if (cmd.startsWith("LIST ENUM ")) {
      const parts = cmd.split(" ");
      const ups = parts[2];
      const varName = parts[3];
      return [
        `BEGIN LIST ENUM ${ups} ${varName}`,
        `ENUM ${ups} ${varName} "200"`,
        `ENUM ${ups} ${varName} "230"`,
        `ENUM ${ups} ${varName} "240"`,
        `END LIST ENUM ${ups} ${varName}`,
      ];
    }
    if (cmd.startsWith("LIST RANGE ")) {
      const parts = cmd.split(" ");
      const ups = parts[2];
      const varName = parts[3];
      return [
        `BEGIN LIST RANGE ${ups} ${varName}`,
        `RANGE ${ups} ${varName} "100" "280"`,
        `END LIST RANGE ${ups} ${varName}`,
      ];
    }
    if (cmd.startsWith("SET VAR ")) {
      return "OK";
    }
    if (cmd.startsWith("INSTCMD ")) {
      return "OK";
    }
    if (cmd.startsWith("USERNAME ")) {
      return "OK";
    }
    if (cmd.startsWith("PASSWORD ")) {
      return "OK";
    }
    if (cmd.startsWith("LOGIN ")) {
      return "OK";
    }
    return "ERR UNKNOWN-COMMAND";
  };

  const server = net.createServer(socket => {
    let buf = "";
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.setEncoding("utf8");
    socket.on("data", (data: string) => {
      buf += data;
      const lines = buf.split("\n");
      buf = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        commands.push(trimmed);

        const h = handler ?? defaultHandler;
        const response = h(trimmed);
        if (response === null) {
          return;
        }
        if (Array.isArray(response)) {
          for (const r of response) {
            socket.write(`${r}\n`);
          }
        } else {
          socket.write(`${response}\n`);
        }
      }
    });
  });

  return {
    server,
    get port() {
      return port;
    },
    commands,
    start: () =>
      new Promise<number>(resolve => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as net.AddressInfo;
          port = addr.port;
          resolve(port);
        });
      }),
    stop: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve());
      }),
    disconnectAll: () => {
      for (const conn of connections) {
        conn.destroy();
      }
    },
  };
}

// A mock server that answers STARTTLS with "OK STARTTLS" and then completes a REAL TLS
// handshake on its side — so the client's plaintext→TLS upgrade is exercised end to end
// (a mock that only checks the STARTTLS line was sent would never trip the upgrade trap).
function createStartTlsMockServer(handler: MockHandler): {
  start: () => Promise<number>;
  stop: () => Promise<void>;
  commands: string[];
  /** Server-names the client offered via SNI (empty when it offered none). */
  sniNames: string[];
} {
  const commands: string[] = [];
  const connections = new Set<net.Socket | tls.TLSSocket>();
  const sniNames: string[] = [];
  let port = 0;

  const respond = (sock: net.Socket | tls.TLSSocket, cmd: string): void => {
    commands.push(cmd);
    const r = handler(cmd);
    if (r === null) {
      return;
    }
    if (Array.isArray(r)) {
      for (const line of r) {
        sock.write(`${line}\n`);
      }
    } else {
      sock.write(`${r}\n`);
    }
  };

  const server = net.createServer(socket => {
    connections.add(socket);
    socket.setEncoding("utf8");
    let buf = "";

    const onPlain = (data: string): void => {
      buf += data;
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        if (trimmed === "STARTTLS") {
          commands.push("STARTTLS");
          socket.removeListener("data", onPlain);
          socket.write("OK STARTTLS\n");
          // Upgrade THIS side to a TLS server socket — drives a genuine handshake.
          const tlsSocket = new tls.TLSSocket(socket, {
            isServer: true,
            secureContext: tls.createSecureContext({ cert: TEST_TLS_CERT, key: TEST_TLS_KEY }),
            // Record the SNI the client offered — RFC 6066 forbids an IP literal there.
            SNICallback: (name, cb) => {
              sniNames.push(name);
              cb(null, tls.createSecureContext({ cert: TEST_TLS_CERT, key: TEST_TLS_KEY }));
            },
          });
          connections.add(tlsSocket);
          tlsSocket.setEncoding("utf8");
          let tbuf = "";
          tlsSocket.on("data", (tdata: string) => {
            tbuf += tdata;
            const tlines = tbuf.split("\n");
            tbuf = tlines.pop()!;
            for (const tline of tlines) {
              const t = tline.trim();
              if (t) {
                respond(tlsSocket, t);
              }
            }
          });
          tlsSocket.on("error", () => {});
          return; // anything buffered after STARTTLS would be a protocol violation — ignore
        }
        respond(socket, trimmed);
      }
    };

    socket.on("data", onPlain);
    socket.on("error", () => {});
  });

  return {
    commands,
    sniNames,
    start: () =>
      new Promise<number>(resolve => {
        server.listen(0, "127.0.0.1", () => {
          port = (server.address() as net.AddressInfo).port;
          resolve(port);
        });
      }),
    stop: () =>
      new Promise<void>(resolve => {
        for (const c of connections) {
          c.destroy();
        }
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** A promise plus its resolver — for awaiting individual onConnect fires. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("NutClient", () => {
  // -----------------------------------------------------------------------
  // Connection
  // -----------------------------------------------------------------------
  describe("connect", () => {
    it("should connect to a NUT server", async () => {
      const mock = createMockNutServer();
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        expect(client.isConnected).toBe(true);
        client.destroy();
      } finally {
        await mock.stop();
      }
    });

    it("should reject when server is unavailable", async () => {
      const client = new NutClient("127.0.0.1", 1);
      await expect(client.connect()).rejects.toThrow();
    });

    it("should report not connected before connect", () => {
      const client = new NutClient("127.0.0.1", 3493);
      expect(client.isConnected).toBe(false);
    });

    it("should reject connect after destroy", async () => {
      const client = new NutClient("127.0.0.1", 3493);
      client.destroy();
      await expect(client.connect()).rejects.toThrow("Client has been destroyed");
    });

    it("start() after destroy opens no socket at all", async () => {
      const mock = createMockNutServer();
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        client.destroy();
        // A reconnect timer that fires during teardown, or a late start() from
        // onReady racing onUnload, must not resurrect the connection.
        client.start();
        await new Promise(r => setTimeout(r, 150));
        expect(client.isConnected).toBe(false);
        expect(mock.commands, "no NUT traffic after destroy").toEqual([]);
      } finally {
        await mock.stop();
      }
    });
  });

  describe("connect-phase timeout", () => {
    it("times out the connect/STARTTLS phase instead of hanging for the OS timeout", { timeout: 10000 }, async () => {
      // Server accepts TCP and answers STARTTLS with OK, then never upgrades to TLS — the
      // client's tls.connect() would otherwise hang until the OS connect timeout (~1-2 min).
      const server = net.createServer(sock => {
        sock.setEncoding("utf8");
        sock.on("data", (d: string) => {
          if (d.includes("STARTTLS")) {
            sock.write("OK STARTTLS\n");
          }
          // …then nothing: no TLS handshake follows.
        });
        sock.on("error", () => {});
      });
      const port = await new Promise<number>(r =>
        server.listen(0, "127.0.0.1", () => r((server.address() as net.AddressInfo).port)),
      );
      try {
        const client = new NutClient("127.0.0.1", port, { useTls: true, commandTimeout: 300 });
        const start = Date.now();
        await expect(client.connect()).rejects.toThrow(/timed out/i);
        expect(Date.now() - start).toBeLessThan(3000);
        client.destroy();
      } finally {
        await new Promise<void>(r => server.close(() => r()));
      }
    });
  });

  // -----------------------------------------------------------------------
  // LIST UPS
  // -----------------------------------------------------------------------
  describe("listUps", () => {
    it("should return all UPS devices", async () => {
      const mock = createMockNutServer();
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        const upsList = await client.listUps();
        expect(upsList).toEqual([
          { name: "ups0", description: "Main UPS" },
          { name: "ups1", description: "Backup UPS" },
        ]);
        client.destroy();
      } finally {
        await mock.stop();
      }
    });

    it("should handle empty UPS list", async () => {
      const mock = createMockNutServer(cmd => {
        if (cmd === "LIST UPS") {
          return ["BEGIN LIST UPS", "END LIST UPS"];
        }
        return "ERR UNKNOWN-COMMAND";
      });
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        const upsList = await client.listUps();
        expect(upsList).toEqual([]);
        client.destroy();
      } finally {
        await mock.stop();
      }
    });

    it("should handle escaped quotes in UPS description", async () => {
      const mock = createMockNutServer(cmd => {
        if (cmd === "LIST UPS") {
          return ["BEGIN LIST UPS", 'UPS ups0 "Main \\"backup\\" UPS"', "END LIST UPS"];
        }
        return "ERR UNKNOWN-COMMAND";
      });
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        const upsList = await client.listUps();
        expect(upsList).toEqual([{ name: "ups0", description: 'Main "backup" UPS' }]);
        client.destroy();
      } finally {
        await mock.stop();
      }
    });
  });

  // -----------------------------------------------------------------------
  // LIST VAR
  // -----------------------------------------------------------------------
  describe("listVar", () => {
    it("should return all variables for a UPS", async () => {
      const mock = createMockNutServer();
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        const vars = await client.listVar("ups0");
        expect(vars).toEqual([
          { name: "battery.charge", value: "100" },
          { name: "ups.status", value: "OL" },
          { name: "ups.load", value: "15" },
        ]);
        client.destroy();
      } finally {
        await mock.stop();
      }
    });

    it("should reject on unknown UPS", async () => {
      const mock = createMockNutServer(cmd => {
        if (cmd === "LIST VAR unknown") {
          return "ERR UNKNOWN-UPS";
        }
        return "ERR UNKNOWN-COMMAND";
      });
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        await expect(client.listVar("unknown")).rejects.toThrow(NutError);
        await expect(client.listVar("unknown")).rejects.toMatchObject({ code: "UNKNOWN-UPS" });
        client.destroy();
      } finally {
        await mock.stop();
      }
    });
  });

  // -----------------------------------------------------------------------
  // LIST RW
  // -----------------------------------------------------------------------
  describe("listRw", () => {
    it("should return writable variables", async () => {
      const mock = createMockNutServer();
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        const rw = await client.listRw("ups0");
        expect(rw).toEqual([{ name: "ups.delay.shutdown", value: "20" }]);
        client.destroy();
      } finally {
        await mock.stop();
      }
    });
  });

  // -----------------------------------------------------------------------
  // LIST CMD
  // -----------------------------------------------------------------------
  describe("listCmd", () => {
    it("should return available commands", async () => {
      const mock = createMockNutServer();
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        const cmds = await client.listCmd("ups0");
        expect(cmds).toEqual([{ name: "beeper.enable" }, { name: "load.off" }]);
        client.destroy();
      } finally {
        await mock.stop();
      }
    });
  });

  // -----------------------------------------------------------------------
  // LIST ENUM
  // -----------------------------------------------------------------------
  describe("listEnum", () => {
    it("should return enum values", async () => {
      const mock = createMockNutServer();
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        const enums = await client.listEnum("ups0", "output.voltage.nominal");
        expect(enums).toEqual(["200", "230", "240"]);
        client.destroy();
      } finally {
        await mock.stop();
      }
    });
  });

  // -----------------------------------------------------------------------
  // LIST RANGE
  // -----------------------------------------------------------------------
  describe("listRange", () => {
    it("should return range constraints", async () => {
      const mock = createMockNutServer();
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        const ranges = await client.listRange("ups0", "input.transfer.high");
        expect(ranges).toEqual([{ min: "100", max: "280" }]);
        client.destroy();
      } finally {
        await mock.stop();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Single-line commands (SET VAR walks the same one-line request/response path)
  // -----------------------------------------------------------------------
  describe("single-line commands", () => {
    it("should reject on VAR-NOT-SUPPORTED", async () => {
      const mock = createMockNutServer(cmd => {
        if (cmd.startsWith("SET VAR")) {
          return "ERR VAR-NOT-SUPPORTED";
        }
        return "ERR UNKNOWN-COMMAND";
      });
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        await expect(client.setVar("ups0", "no.such.var", "1")).rejects.toThrow(NutError);
        client.destroy();
      } finally {
        await mock.stop();
      }
    });
  });

  // -----------------------------------------------------------------------
  // SET VAR
  // -----------------------------------------------------------------------
  describe("setVar", () => {
    it("should send SET VAR with escaped value", async () => {
      const mock = createMockNutServer();
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        await client.setVar("ups0", "ups.delay.shutdown", "30");
        expect(mock.commands).toContain('SET VAR ups0 ups.delay.shutdown "30"');
        client.destroy();
      } finally {
        await mock.stop();
      }
    });

    it("should escape special characters in value", async () => {
      const mock = createMockNutServer();
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        await client.setVar("ups0", "outlet.desc", 'Test "outlet" \\ 1');
        expect(mock.commands).toContain('SET VAR ups0 outlet.desc "Test \\"outlet\\" \\\\ 1"');
        client.destroy();
      } finally {
        await mock.stop();
      }
    });

    it("should reject on SET-FAILED", async () => {
      const mock = createMockNutServer(cmd => {
        if (cmd.startsWith("SET VAR")) {
          return "ERR SET-FAILED";
        }
        return "ERR UNKNOWN-COMMAND";
      });
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        await expect(client.setVar("ups0", "ups.delay.shutdown", "30")).rejects.toMatchObject({
          code: "SET-FAILED",
        });
        client.destroy();
      } finally {
        await mock.stop();
      }
    });

    it("refuses a value containing a line break at the wire (defense in depth)", async () => {
      // A SET VAR value goes out quoted and escapeNut neutralises quotes/backslashes, so upsd
      // reads a newline inside the quotes literally — it cannot be smuggled into a second command.
      // The client still refuses it up front rather than send a malformed line.
      const mock = createMockNutServer();
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        mock.commands.length = 0;
        await expect(client.setVar("ups0", "outlet.desc", "x\nINSTCMD ups0 load.off")).rejects.toThrow();
        expect(mock.commands.some(c => c.includes("INSTCMD"))).toBe(false);
        client.destroy();
      } finally {
        await mock.stop();
      }
    });
  });

  // -----------------------------------------------------------------------
  // INSTCMD
  // -----------------------------------------------------------------------
  describe("protocol argument guard", () => {
    it("refuses a variable or command name that is not one clean token (nothing reaches the wire)", async () => {
      const mock = createMockNutServer();
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        await expect(client.setVar("ups0", "ups.delay shutdown", "20")).rejects.toThrow("Invalid NUT variable name");
        await expect(client.setVar("ups0", 'a"b', "20")).rejects.toThrow("Invalid NUT variable name");
        await expect(client.instCmd("ups0", "load off")).rejects.toThrow("Invalid NUT command name");
        await expect(client.listEnum("ups 0", "x")).rejects.toThrow("Invalid NUT UPS name");
        await expect(client.listRange("ups0", "x\\y")).rejects.toThrow("Invalid NUT variable name");
        await expect(client.listVar("u p")).rejects.toThrow("Invalid NUT UPS name");
        await expect(client.login("u p")).rejects.toThrow("Invalid NUT UPS name");
        // These two were the only guarded calls without a test — the guard exists for a UPS name
        // that reaches the client from a hand-made object, and it has to hold on every path.
        await expect(client.listRw("u p")).rejects.toThrow("Invalid NUT UPS name");
        await expect(client.listCmd('a"b')).rejects.toThrow("Invalid NUT UPS name");
        // An empty token is the other half of the guard: `SET VAR ups0  20` would put the
        // value where upsd expects the name (mutation N12, 2026-09-08).
        await expect(client.setVar("ups0", "", "20")).rejects.toThrow("Invalid NUT variable name");
        await expect(client.instCmd("ups0", "")).rejects.toThrow("Invalid NUT command name");
        await expect(client.listVar("")).rejects.toThrow("Invalid NUT UPS name");
        expect(mock.commands).toEqual([]);
        // A clean token still goes through.
        await client.setVar("ups0", "ups.delay.shutdown", "20");
        expect(mock.commands).toEqual(['SET VAR ups0 ups.delay.shutdown "20"']);
        client.destroy();
      } finally {
        await mock.stop();
      }
    });
  });

  describe("instCmd", () => {
    it("should send INSTCMD", async () => {
      const mock = createMockNutServer();
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        await client.instCmd("ups0", "beeper.enable");
        expect(mock.commands).toContain("INSTCMD ups0 beeper.enable");
        client.destroy();
      } finally {
        await mock.stop();
      }
    });

    it("should reject on INSTCMD-FAILED", async () => {
      const mock = createMockNutServer(cmd => {
        if (cmd.startsWith("INSTCMD")) {
          return "ERR INSTCMD-FAILED";
        }
        return "ERR UNKNOWN-COMMAND";
      });
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        await expect(client.instCmd("ups0", "load.off")).rejects.toMatchObject({
          code: "INSTCMD-FAILED",
        });
        client.destroy();
      } finally {
        await mock.stop();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Authentication
  // -----------------------------------------------------------------------
  describe("authenticate", () => {
    it("should send USERNAME and PASSWORD", async () => {
      const mock = createMockNutServer();
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        await client.authenticate("admin", "secret");
        expect(mock.commands).toContain("USERNAME admin");
        expect(mock.commands).toContain("PASSWORD secret");
        client.destroy();
      } finally {
        await mock.stop();
      }
    });

    it("names the cause when a credential carries a space, and sends nothing", async () => {
      // upsd takes exactly one argument here (`numarg != 1` → ERR INVALID-ARGUMENT,
      // server/netuser.c:147 and :167 of NUT 2.8.5), so a space splits it into two and the server
      // answers with a bare INVALID-ARGUMENT that names nothing — the user then hunts the password,
      // upsd.users and the rights. The protocol token guard covered every other unquoted argument
      // but not these two.
      const mock = createMockNutServer();
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        mock.commands.length = 0;
        await expect(client.authenticate("ad min", "secret")).rejects.toThrow(/username contains a space/i);
        await expect(client.authenticate("admin", "se cret")).rejects.toThrow(/password contains a space/i);
        await expect(client.authenticate("admin", "sec\tret")).rejects.toThrow(/password contains a space/i);
        // Nothing may reach the wire — not even the USERNAME that on its own would be fine.
        expect(mock.commands).toEqual([]);
        client.destroy();
      } finally {
        await mock.stop();
      }
    });

    it("refuses a quote or backslash in a credential — unquoted, the server would read another value", async () => {
      const mock = createMockNutServer();
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        mock.commands.length = 0;
        await expect(client.authenticate("admin", 'sec"ret')).rejects.toThrow(/quote or a backslash/i);
        await expect(client.authenticate("admin", "sec\\ret")).rejects.toThrow(/quote or a backslash/i);
        await expect(client.authenticate("", "secret")).rejects.toThrow(/username is empty/i);
        expect(mock.commands).toEqual([]);
        client.destroy();
      } finally {
        await mock.stop();
      }
    });

    it("never puts the credential itself into the error message", async () => {
      // The text lands in the log and in the admin's connection-test answer, and both values are
      // protectedNative/encryptedNative. It says WHAT is wrong, never what was entered.
      const mock = createMockNutServer();
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        await expect(client.authenticate("admin", "hunter 2")).rejects.toThrow(
          expect.objectContaining({ message: expect.not.stringContaining("hunter") }),
        );
        client.destroy();
      } finally {
        await mock.stop();
      }
    });

    it("refuses a password with a line break — the one unquoted path onto the wire", async () => {
      // USERNAME/PASSWORD are sent without quotes, so a newline in the value (a pasted credential
      // with a trailing newline) would split into a bogus second command line. Refuse it instead.
      const mock = createMockNutServer();
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        mock.commands.length = 0;
        await expect(client.authenticate("admin", "secret\nLOGOUT")).rejects.toThrow();
        expect(mock.commands.some(c => c === "LOGOUT")).toBe(false);
        client.destroy();
      } finally {
        await mock.stop();
      }
    });

    it("should reject on INVALID-PASSWORD", async () => {
      const mock = createMockNutServer(cmd => {
        if (cmd.startsWith("USERNAME")) {
          return "OK";
        }
        if (cmd.startsWith("PASSWORD")) {
          return "ERR INVALID-PASSWORD";
        }
        return "ERR UNKNOWN-COMMAND";
      });
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        await expect(client.authenticate("admin", "wrong")).rejects.toMatchObject({
          code: "INVALID-PASSWORD",
        });
        client.destroy();
      } finally {
        await mock.stop();
      }
    });

    it("should reject on INVALID-USERNAME", async () => {
      const mock = createMockNutServer(cmd => {
        if (cmd.startsWith("USERNAME")) {
          return "ERR INVALID-USERNAME";
        }
        return "ERR UNKNOWN-COMMAND";
      });
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        await expect(client.authenticate("bad", "pw")).rejects.toMatchObject({
          code: "INVALID-USERNAME",
        });
        client.destroy();
      } finally {
        await mock.stop();
      }
    });
  });

  // -----------------------------------------------------------------------
  // LOGIN
  // -----------------------------------------------------------------------
  describe("login", () => {
    it("should send LOGIN for a UPS", async () => {
      const mock = createMockNutServer();
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        await client.login("ups0");
        expect(mock.commands).toContain("LOGIN ups0");
        client.destroy();
      } finally {
        await mock.stop();
      }
    });

    it("should handle ALREADY-LOGGED-IN gracefully", async () => {
      const mock = createMockNutServer(cmd => {
        if (cmd.startsWith("LOGIN")) {
          return "ERR ALREADY-LOGGED-IN";
        }
        return "ERR UNKNOWN-COMMAND";
      });
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        await expect(client.login("ups0")).rejects.toMatchObject({
          code: "ALREADY-LOGGED-IN",
        });
        client.destroy();
      } finally {
        await mock.stop();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------
  describe("error handling", () => {
    it("should parse NUT error codes", async () => {
      const mock = createMockNutServer(cmd => {
        if (cmd.startsWith("SET VAR")) {
          return "ERR ACCESS-DENIED";
        }
        return "ERR UNKNOWN-COMMAND";
      });
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        try {
          await client.setVar("ups0", "battery.charge", "1");
          expect.unreachable("should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(NutError);
          expect((err as NutError).code).toBe("ACCESS-DENIED");
        }
        client.destroy();
      } finally {
        await mock.stop();
      }
    });

    it("should handle DATA-STALE error", async () => {
      const mock = createMockNutServer(cmd => {
        if (cmd.startsWith("LIST VAR")) {
          return "ERR DATA-STALE";
        }
        return "ERR UNKNOWN-COMMAND";
      });
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        await expect(client.listVar("ups0")).rejects.toMatchObject({ code: "DATA-STALE" });
        client.destroy();
      } finally {
        await mock.stop();
      }
    });

    it("should reject commands when not connected", async () => {
      const client = new NutClient("127.0.0.1", 3493);
      await expect(client.listUps()).rejects.toThrow("Not connected");
    });
  });

  // -----------------------------------------------------------------------
  // Command timeout
  // -----------------------------------------------------------------------
  describe("command timeout", () => {
    it("should timeout on unresponsive server", async () => {
      const mock = createMockNutServer(() => null);
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port, { commandTimeout: 100 });
        await client.connect();
        await expect(client.listUps()).rejects.toThrow(NutTimeoutError);
        client.destroy();
      } finally {
        await mock.stop();
      }
    });

    it("should use custom timeout", async () => {
      const mock = createMockNutServer(() => null);
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port, { commandTimeout: 50 });
        await client.connect();
        const start = Date.now();
        await expect(client.listUps()).rejects.toThrow(NutTimeoutError);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(300);
        client.destroy();
      } finally {
        await mock.stop();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Queue serialization
  // -----------------------------------------------------------------------
  describe("command queue", () => {
    it("should serialize concurrent commands", async () => {
      const mock = createMockNutServer();
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();

        const [ups, vars, cmds] = await Promise.all([client.listUps(), client.listVar("ups0"), client.listCmd("ups0")]);

        expect(ups.length).toBe(2);
        expect(vars.length).toBe(3);
        expect(cmds.length).toBe(2);

        expect(mock.commands[0]).toBe("LIST UPS");
        expect(mock.commands[1]).toBe("LIST VAR ups0");
        expect(mock.commands[2]).toBe("LIST CMD ups0");

        client.destroy();
      } finally {
        await mock.stop();
      }
    });

    it("should process next command after error", async () => {
      let callCount = 0;
      const mock = createMockNutServer(cmd => {
        if (cmd.startsWith("SET VAR")) {
          callCount++;
          if (callCount === 1) {
            return "ERR VAR-NOT-SUPPORTED";
          }
          return "OK";
        }
        return "ERR UNKNOWN-COMMAND";
      });
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();

        await expect(client.setVar("ups0", "no.such.var", "1")).rejects.toThrow(NutError);
        await client.setVar("ups0", "ups.load", "15");

        client.destroy();
      } finally {
        await mock.stop();
      }
    });

    it("desyncs and reconnects after a command timeout (resync)", { timeout: 10000 }, async () => {
      let respond = false;
      const mock = createMockNutServer(cmd => {
        if (cmd.startsWith("SET VAR")) {
          return respond ? "OK" : null; // no response → timeout
        }
        return "ERR UNKNOWN-COMMAND";
      });
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port, { commandTimeout: 80 });
        const first = deferred();
        const reconnected = deferred();
        let n = 0;
        client.setOnConnect(() => {
          n += 1;
          (n === 1 ? first : reconnected).resolve();
        });
        client.start();
        await first.promise;

        // A timeout desyncs the stream (no request IDs) → drop the connection to resync.
        await expect(client.setVar("ups0", "battery.charge", "1")).rejects.toThrow(NutTimeoutError);
        expect(client.isConnected).toBe(false);

        // …then it reconnects and commands work again on a clean stream.
        respond = true;
        await reconnected.promise;
        expect(client.isConnected).toBe(true);
        await client.setVar("ups0", "ups.load", "15");

        client.destroy();
      } finally {
        await mock.stop();
      }
    });
    it(
      "does not time out a queued command for the time it waits behind an active one",
      { timeout: 10000 },
      async () => {
        // Every response is delayed by DELAY ms. Two commands go out via Promise.all (as poll()
        // does): LIST VAR is active from t=0 (done ~DELAY); LIST RW waits in the queue and only
        // becomes active at ~DELAY (done ~2·DELAY). With the timeout armed at ENQUEUE it fires at
        // commandTimeout from t=0 and kills LIST RW even though it barely had any *active* time.
        const DELAY = 200;
        const server = net.createServer(sock => {
          sock.setEncoding("utf8");
          let buf = "";
          sock.on("data", (d: string) => {
            buf += d;
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines) {
              const cmd = line.trim();
              setTimeout(() => {
                if (cmd.startsWith("LIST VAR")) {
                  sock.write('BEGIN LIST VAR ups0\nVAR ups0 battery.charge "100"\nEND LIST VAR ups0\n');
                } else if (cmd.startsWith("LIST RW")) {
                  sock.write("BEGIN LIST RW ups0\nEND LIST RW ups0\n");
                } else {
                  sock.write("ERR UNKNOWN-COMMAND\n");
                }
              }, DELAY);
            }
          });
          sock.on("error", () => {});
        });
        const port = await new Promise<number>(r =>
          server.listen(0, "127.0.0.1", () => r((server.address() as net.AddressInfo).port)),
        );
        try {
          const client = new NutClient("127.0.0.1", port, { commandTimeout: 300 });
          await client.connect();
          // LIST RW needs > commandTimeout of wall-clock (queue-wait + run) but < commandTimeout
          // of *active* time. It must NOT be timed out and drop the connection.
          const [vars, rw] = await Promise.all([client.listVar("ups0"), client.listRw("ups0")]);
          expect(vars.length).toBeGreaterThan(0);
          expect(Array.isArray(rw)).toBe(true);
          expect(client.isConnected).toBe(true);
          client.destroy();
        } finally {
          await new Promise<void>(r => server.close(() => r()));
        }
      },
    );
  });

  // -----------------------------------------------------------------------
  // cancelAll
  // -----------------------------------------------------------------------
  describe("cancelAll", () => {
    it("should reject all pending commands", async () => {
      const mock = createMockNutServer(() => null);
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port, { commandTimeout: 10000 });
        await client.connect();

        const p1 = client.listUps();
        const p2 = client.listVar("ups0");

        client.cancelAll();

        await expect(p1).rejects.toThrow("Client cancelled");
        await expect(p2).rejects.toThrow("Client cancelled");

        client.destroy();
      } finally {
        await mock.stop();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Receive-buffer bound
  // -----------------------------------------------------------------------
  describe("receive-buffer bound", () => {
    it("drops the connection when bytes stream in without a line break past the cap", { timeout: 15000 }, async () => {
      // The leak case: between commands nothing bounds the line buffer — the command timeout only
      // covers an ACTIVE command, so a server that keeps sending bytes with NO line break would
      // grow it without limit. A raw server (the shared mock always appends "\n", which would make
      // it one complete line instead) streams > cap bytes and never terminates the line.
      const server = net.createServer(socket => {
        socket.setEncoding("utf8");
        socket.on("data", (d: string) => {
          if (d.includes("SET VAR")) {
            socket.write("x".repeat(MAX_LINE_BYTES + 64)); // no trailing "\n": an unterminated line
          }
        });
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
      const port = (server.address() as net.AddressInfo).port;
      try {
        const client = new NutClient("127.0.0.1", port, { commandTimeout: 10000 });
        await client.connect();
        await expect(client.setVar("ups0", "ups.status", "x")).rejects.toThrow(/line/i);
        expect(client.isConnected).toBe(false);
        client.destroy();
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });
  });

  // -----------------------------------------------------------------------
  // destroy
  // -----------------------------------------------------------------------
  describe("destroy", () => {
    it("should close connection and reject pending", async () => {
      const mock = createMockNutServer(() => null);
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port, { commandTimeout: 10000 });
        await client.connect();
        expect(client.isConnected).toBe(true);

        const p = client.listUps();
        client.destroy();

        await expect(p).rejects.toThrow("Client cancelled");
        expect(client.isConnected).toBe(false);
      } finally {
        await mock.stop();
      }
    });

    it("clears an armed reconnect timer — a torn-down client must not come back", async () => {
      // Without this the timer fires after the teardown and opens a socket nobody owns any more.
      // The injected timer deliberately NEVER fires: with a real one the reconnect could run
      // before destroy() and the assertion would pass on an already-empty handle — a green test
      // that proves nothing.
      const cleared: unknown[] = [];
      const client = new NutClient("127.0.0.1", 1, {
        commandTimeout: 50,
        setTimer: cb => ({ cb }),
        clearTimer: h => cleared.push(h),
      });
      client.start(); // port 1 → connect fails → a reconnect gets scheduled
      await vi.waitFor(() => {
        // @ts-expect-error reading the private timer handle to prove it was armed
        expect(client.reconnectTimer).not.toBeNull();
      });
      // @ts-expect-error the very handle destroy() has to hand to clearTimer
      const armed = client.reconnectTimer;

      client.destroy();

      expect(cleared).toContain(armed);
      // @ts-expect-error the handle is dropped, not just cleared
      expect(client.reconnectTimer).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Socket close drains the whole queue (not just the active command)
  // -----------------------------------------------------------------------
  describe("socket close", () => {
    it(
      "rejects queued commands too when the connection drops (no orphaned queue entry)",
      { timeout: 10000 },
      async () => {
        const mock = createMockNutServer(() => null); // never responds → commands stay pending
        const port = await mock.start();
        try {
          // High commandTimeout so the only way a queued command can settle is the close-drain,
          // not its own timer firing.
          const client = new NutClient("127.0.0.1", port, { commandTimeout: 10000 });
          await client.connect();

          const active = client.listUps(); // becomes active (mock hangs)
          const queued = client.listVar("ups0"); // waits in the queue behind it

          // Drop the connection from underneath both commands.
          // @ts-expect-error accessing private socket for a deterministic disconnect
          client.socket!.destroy();

          await expect(active).rejects.toThrow(); // active — handled even before the fix
          await expect(queued).rejects.toThrow(); // queued — was orphaned (never settled) before the fix

          client.destroy();
        } finally {
          await mock.stop();
        }
      },
    );
  });

  // -----------------------------------------------------------------------
  // Reconnect
  // -----------------------------------------------------------------------
  describe("reconnect", () => {
    it("reconnects on drop and re-fires onConnect (idempotent re-entry)", { timeout: 10000 }, async () => {
      const mock = createMockNutServer();
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port, { commandTimeout: 2000 });
        const first = deferred();
        const reconnected = deferred();
        let n = 0;
        client.setOnConnect(() => {
          n += 1;
          (n === 1 ? first : reconnected).resolve();
        });
        client.start();
        await first.promise;
        expect(client.isConnected).toBe(true);

        // Destroy socket directly — going through TCP (mock.disconnectAll) has timing variance
        // @ts-expect-error accessing private socket for a deterministic disconnect
        client.socket!.destroy();

        await reconnected.promise;
        expect(client.isConnected).toBe(true);
        expect(n).toBe(2); // onConnect ran again on reconnect — initial == reconnect, one path
        client.destroy();
      } finally {
        await mock.stop();
      }
    });

    it("retries the initial connect with backoff until the server appears", { timeout: 10000 }, async () => {
      const probe = createMockNutServer();
      const port = await probe.start();
      await probe.stop(); // port now free → the initial connect fails (ECONNREFUSED)

      const client = new NutClient("127.0.0.1", port, { commandTimeout: 2000 });
      const connected = deferred();
      client.setOnConnect(() => connected.resolve());
      client.start();

      // Bring a server up on the same port; the backed-off retry must find it.
      const reup = net.createServer(s => {
        s.setEncoding("utf8");
        s.on("error", () => {});
      });
      await new Promise<void>(r => reup.listen(port, "127.0.0.1", () => r()));
      try {
        await connected.promise; // a retry succeeded after the initial failure
        expect(client.isConnected).toBe(true);
        client.destroy();
      } finally {
        await new Promise<void>(r => reup.close(() => r()));
      }
    });

    it("stops on a fatal TLS-config error (onFatal, no retry)", { timeout: 10000 }, async () => {
      const mock = createMockNutServer(cmd => {
        if (cmd === "STARTTLS") {
          return "ERR FEATURE-NOT-CONFIGURED";
        }
        return "ERR UNKNOWN-COMMAND";
      });
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port, { useTls: true });
        const fatal = deferred();
        let connectCount = 0;
        let fatalErr: unknown;
        client.setOnConnect(() => {
          connectCount += 1;
        });
        client.setOnFatal(err => {
          fatalErr = err;
          fatal.resolve();
        });
        client.start();

        await fatal.promise;
        expect((fatalErr as NutError).code).toBe("FEATURE-NOT-CONFIGURED");
        expect(client.isConnected).toBe(false);
        // No retry must be scheduled — onConnect never fires.
        await new Promise(r => setTimeout(r, 200));
        expect(connectCount).toBe(0);
        client.destroy();
      } finally {
        await mock.stop();
      }
    });

    it("stops the retry loop on destroy() during backoff", { timeout: 10000 }, async () => {
      const probe = createMockNutServer();
      const port = await probe.start();
      await probe.stop(); // port closed → initial connect fails, retry scheduled (~1s)

      const client = new NutClient("127.0.0.1", port, { commandTimeout: 2000 });
      let connectCount = 0;
      client.setOnConnect(() => {
        connectCount += 1;
      });
      client.start();

      await new Promise(r => setTimeout(r, 100)); // let the first attempt fail + arm the retry
      client.destroy();
      await new Promise(r => setTimeout(r, 1300)); // past the backoff window — retry must not fire
      expect(connectCount).toBe(0);
      expect(client.isConnected).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Logger integration
  // -----------------------------------------------------------------------
  describe("logger", () => {
    it("should call logger.debug for commands", async () => {
      const logs: string[] = [];
      const logger = {
        debug: (msg: string) => logs.push(msg),
        warn: (msg: string) => logs.push(`WARN: ${msg}`),
        info: (msg: string) => logs.push(`INFO: ${msg}`),
      };

      const mock = createMockNutServer();
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port, { logger });
        await client.connect();
        await client.listUps();
        client.destroy();

        expect(logs.some(l => l.includes("Connected to NUT server"))).toBe(true);
        expect(logs.some(l => l.includes(">> LIST UPS"))).toBe(true);
      } finally {
        await mock.stop();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Multi-line edge cases
  // -----------------------------------------------------------------------
  describe("multi-line parsing", () => {
    it("should handle large LIST VAR responses", async () => {
      const mock = createMockNutServer(cmd => {
        if (cmd === "LIST VAR bigups") {
          const lines = ["BEGIN LIST VAR bigups"];
          for (let i = 0; i < 100; i++) {
            lines.push(`VAR bigups var.${i} "${i}"`);
          }
          lines.push("END LIST VAR bigups");
          return lines;
        }
        return "ERR UNKNOWN-COMMAND";
      });
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        const vars = await client.listVar("bigups");
        expect(vars.length).toBe(100);
        expect(vars[0]).toEqual({ name: "var.0", value: "0" });
        expect(vars[99]).toEqual({ name: "var.99", value: "99" });
        client.destroy();
      } finally {
        await mock.stop();
      }
    });

    it("should handle chunked TCP data", async () => {
      const server = net.createServer(socket => {
        socket.setEncoding("utf8");
        let buf = "";
        socket.on("data", (data: string) => {
          buf += data;
          if (buf.includes("\n")) {
            buf = "";
            // Send response in multiple chunks with delays
            socket.write("BEGIN LIST UPS\n");
            setTimeout(() => {
              socket.write("UPS ups");
              setTimeout(() => {
                socket.write('0 "Test UPS"\n');
                setTimeout(() => {
                  socket.write("END LIST UPS\n");
                }, 10);
              }, 10);
            }, 10);
          }
        });
      });

      const port = await new Promise<number>(resolve => {
        server.listen(0, "127.0.0.1", () => {
          resolve((server.address() as net.AddressInfo).port);
        });
      });

      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        const ups = await client.listUps();
        expect(ups).toEqual([{ name: "ups0", description: "Test UPS" }]);
        client.destroy();
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });

    it("should handle values with escaped backslashes", async () => {
      const mock = createMockNutServer(cmd => {
        if (cmd.startsWith("LIST VAR")) {
          return ["BEGIN LIST VAR ups0", 'VAR ups0 test.var "path\\\\to\\\\file"', "END LIST VAR ups0"].join("\n");
        }
        return "ERR UNKNOWN-COMMAND";
      });
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        const vars = await client.listVar("ups0");
        expect(vars).toEqual([{ name: "test.var", value: "path\\to\\file" }]);
        client.destroy();
      } finally {
        await mock.stop();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Auth sequence
  // -----------------------------------------------------------------------
  describe("auth sequence", () => {
    it("should authenticate then login in correct order", async () => {
      const mock = createMockNutServer();
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        await client.authenticate("admin", "secret");
        await client.login("ups0");

        expect(mock.commands).toEqual(["USERNAME admin", "PASSWORD secret", "LOGIN ups0"]);
        client.destroy();
      } finally {
        await mock.stop();
      }
    });

    it("should reject login without prior auth", async () => {
      const mock = createMockNutServer(cmd => {
        if (cmd.startsWith("LOGIN")) {
          return "ERR USERNAME-REQUIRED";
        }
        return "OK";
      });
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        await expect(client.login("ups0")).rejects.toMatchObject({
          code: "USERNAME-REQUIRED",
        });
        client.destroy();
      } finally {
        await mock.stop();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Error class properties
  // -----------------------------------------------------------------------
  describe("NutError", () => {
    it("should have code and message properties", () => {
      const err = new NutError("ACCESS-DENIED");
      expect(err.code).toBe("ACCESS-DENIED");
      expect(err.message).toBe("NUT error: ACCESS-DENIED");
      expect(err.name).toBe("NutError");
      expect(err).toBeInstanceOf(Error);
    });

    it("should accept custom message", () => {
      const err = new NutError("ACCESS-DENIED", "Custom message");
      expect(err.message).toBe("Custom message");
    });
  });

  describe("NutTimeoutError", () => {
    it("should have command property", () => {
      const err = new NutTimeoutError("LIST UPS");
      expect(err.command).toBe("LIST UPS");
      expect(err.message).toBe("NUT command timed out: LIST UPS");
      expect(err.name).toBe("NutTimeoutError");
      expect(err).toBeInstanceOf(Error);
    });
  });

  // -----------------------------------------------------------------------
  // STARTTLS
  // -----------------------------------------------------------------------
  describe("STARTTLS", () => {
    it("upgrades to TLS and runs commands over the encrypted channel", { timeout: 10000 }, async () => {
      const mock = createStartTlsMockServer(cmd => {
        if (cmd === "LIST UPS") {
          return ["BEGIN LIST UPS", 'UPS ups0 "Secure UPS"', "END LIST UPS"];
        }
        if (cmd.startsWith("SET VAR")) {
          return "OK";
        }
        return "ERR UNKNOWN-COMMAND";
      });
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port, { useTls: true, tlsRejectUnauthorized: false });
        await client.connect();
        expect(client.isTls).toBe(true);

        // Commands after the upgrade must travel over TLS and still parse correctly.
        const ups = await client.listUps();
        expect(ups).toEqual([{ name: "ups0", description: "Secure UPS" }]);
        // …a single-line command too, not only the multi-line one.
        await client.setVar("ups0", "battery.charge.low", "20");
        expect(mock.commands).toContain('SET VAR ups0 battery.charge.low "20"');
        expect(mock.commands).toContain("STARTTLS");

        client.destroy();
      } finally {
        await mock.stop();
      }
    });

    it("offers no server-name for an IP address (RFC 6066)", { timeout: 10000 }, async () => {
      const mock = createStartTlsMockServer(() => "ERR UNKNOWN-COMMAND");
      const port = await mock.start();
      try {
        // Connecting by IP: an IP literal as server-name is forbidden — Node warns
        // and drops it, and a strict server can reject the handshake outright.
        const client = new NutClient("127.0.0.1", port, { useTls: true, tlsRejectUnauthorized: false });
        await client.connect();
        expect(client.isTls).toBe(true);
        expect(mock.sniNames, "no SNI for an IP host").toEqual([]);
        client.destroy();
      } finally {
        await mock.stop();
      }
    });

    it("a failed TLS handshake on the persistent loop is a failed attempt, not a lost connection", async () => {
      // The mock's certificate is self-signed, so with verification ON the handshake itself fails
      // (DEPTH_ZERO_SELF_SIGNED_CERT): a fatal stop on the persistent loop — no reconnect timer may
      // sit next to it. (Measured: handleConnectFailure runs BEFORE the socket's "close" here, so
      // this case never reached the "lost" branch; the peer-drop test below is the one that does.)
      const mock = createStartTlsMockServer(() => "ERR UNKNOWN-COMMAND");
      const port = await mock.start();
      const warns: string[] = [];
      const debugs: string[] = [];
      const timers: number[] = [];
      try {
        const client = new NutClient("127.0.0.1", port, {
          useTls: true,
          tlsRejectUnauthorized: true,
          logger: { debug: m => debugs.push(m), info: () => {}, warn: m => warns.push(m) },
          setTimer: (cb, ms) => {
            timers.push(ms);
            return globalThis.setTimeout(cb, ms);
          },
          clearTimer: h => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
        });
        const fatal = vi.fn();
        client.setOnFatal(fatal);
        client.start();
        await vi.waitFor(() => expect(fatal).toHaveBeenCalledTimes(1));
        expect((fatal.mock.calls[0][0] as { code?: string }).code).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
        // TCP was up when the handshake failed — the close that follows must not read as "lost",
        // and no reconnect may be armed next to the fatal stop (only the connect deadline ran).
        expect(warns.some(w => w.includes("lost"))).toBe(false);
        // The client notes the fatal at debug only — the adapter reports it once at error level.
        expect(warns).toEqual([]);
        expect(debugs.some(w => w.includes("not retrying"))).toBe(true);
        expect(timers.filter(ms => ms >= 1000 && ms < 5000)).toEqual([]);
        client.destroy();
      } finally {
        await mock.stop();
      }
    });

    it("a peer dropping the connection during STARTTLS is a failed attempt, not a lost connection", async () => {
      // TCP is up, STARTTLS is pending, the peer closes: the close handler runs BEFORE connect()
      // settled — that connection was never usable. It is a failed attempt (backoff through
      // handleConnectFailure), not a "lost" one; deciding on the TCP flag alone warned about
      // losing what never existed.
      const mock = createMockNutServer(() => null); // never answers STARTTLS
      const port = await mock.start();
      const warns: string[] = [];
      const debugs: string[] = [];
      try {
        const client = new NutClient("127.0.0.1", port, {
          useTls: true,
          logger: { debug: m => debugs.push(m), info: () => {}, warn: m => warns.push(m) },
        });
        client.start();
        await vi.waitFor(() => expect(mock.commands).toContain("STARTTLS"));
        mock.disconnectAll(); // the peer drops the socket instead of answering
        await vi.waitFor(() => expect(debugs.some(d => d.includes("Connect attempt failed"))).toBe(true));
        expect(warns.some(w => w.includes("lost"))).toBe(false);
        client.destroy();
      } finally {
        await mock.stop();
      }
    });

    it("rejects connect when the server has no TLS support", async () => {
      const mock = createMockNutServer(cmd => {
        if (cmd === "STARTTLS") {
          return "ERR FEATURE-NOT-CONFIGURED";
        }
        return "ERR UNKNOWN-COMMAND";
      });
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port, { useTls: true });
        await expect(client.connect()).rejects.toMatchObject({ code: "FEATURE-NOT-CONFIGURED" });
        client.destroy();
      } finally {
        await mock.stop();
      }
    });
  });

  // -----------------------------------------------------------------------
  // CRLF tolerance
  // -----------------------------------------------------------------------
  describe("CRLF tolerance", () => {
    it("parses responses terminated with CRLF", async () => {
      const server = net.createServer(socket => {
        socket.setEncoding("utf8");
        let buf = "";
        socket.on("data", (data: string) => {
          buf += data;
          const lines = buf.split("\n");
          buf = lines.pop()!;
          for (const line of lines) {
            if (line.replace(/\r$/, "").trim() === "LIST UPS") {
              socket.write("BEGIN LIST UPS\r\n");
              socket.write('UPS ups0 "CRLF UPS"\r\n');
              socket.write("END LIST UPS\r\n");
            }
          }
        });
      });
      const port = await new Promise<number>(resolve => {
        server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
      });
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        const ups = await client.listUps();
        expect(ups).toEqual([{ name: "ups0", description: "CRLF UPS" }]);
        client.destroy();
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });
  });

  // -----------------------------------------------------------------------
  // LOGOUT
  // -----------------------------------------------------------------------
  describe("logout", () => {
    it("sends LOGOUT", async () => {
      const mock = createMockNutServer(cmd => {
        if (cmd === "LOGOUT") {
          return "OK Goodbye";
        }
        return "ERR UNKNOWN-COMMAND";
      });
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        await client.logout();
        expect(mock.commands).toContain("LOGOUT");
        client.destroy();
      } finally {
        await mock.stop();
      }
    });

    it("swallows errors during logout", async () => {
      const mock = createMockNutServer(cmd => {
        if (cmd === "LOGOUT") {
          return "ERR UNKNOWN-COMMAND";
        }
        return "ERR UNKNOWN-COMMAND";
      });
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        await expect(client.logout()).resolves.toBeUndefined();
        client.destroy();
      } finally {
        await mock.stop();
      }
    });
  });

  // -----------------------------------------------------------------------
  // shutdown (graceful onUnload teardown)
  // -----------------------------------------------------------------------
  describe("shutdown", () => {
    it("sends a best-effort LOGOUT and closes", async () => {
      let resolveLogout: () => void = () => {};
      const gotLogout = new Promise<void>(r => (resolveLogout = r));
      const mock = createMockNutServer(cmd => {
        if (cmd === "LOGOUT") {
          resolveLogout();
          return "OK Goodbye";
        }
        return "ERR UNKNOWN-COMMAND";
      });
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        client.shutdown();
        // The half-close must flush the LOGOUT — the server still receives it.
        await gotLogout;
        expect(mock.commands).toContain("LOGOUT");
        expect(client.isConnected).toBe(false);
      } finally {
        await mock.stop();
      }
    });

    it("falls back to a hard destroy when the socket refuses the goodbye", async () => {
      // onUnload has one second before the host kills the process — a throwing end() must not
      // leave the socket open, and it must never propagate out of a synchronous teardown.
      const mock = createMockNutServer(() => "OK");
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port);
        await client.connect();
        // @ts-expect-error replacing end() on the private socket to force the failure path
        const sock = client.socket as { end: () => void; destroy: () => void };
        let destroyed = false;
        const realDestroy = sock.destroy.bind(sock);
        sock.end = () => {
          throw new Error("write after end");
        };
        sock.destroy = () => {
          destroyed = true;
          realDestroy();
        };

        expect(() => client.shutdown()).not.toThrow();
        expect(destroyed).toBe(true);
        expect(client.isConnected).toBe(false);
      } finally {
        await mock.stop();
      }
    });
  });

  describe("outgoing source address", () => {
    it("binds the connection to the configured local address", async () => {
      // The network-interface selector exists for multi-homed hosts; nothing exercised it, so a
      // wrong option name would have gone unnoticed until a user with two networks complained.
      const mock = createMockNutServer(() => "OK");
      const port = await mock.start();
      try {
        const client = new NutClient("127.0.0.1", port, { localAddress: "127.0.0.1" });
        await client.connect();
        // @ts-expect-error reading the private socket to prove the bind really happened
        expect(client.socket!.localAddress).toBe("127.0.0.1");
        client.destroy();
      } finally {
        await mock.stop();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// isTlsConfigError — fatal (go yellow) vs. transient (retry) classification
// ---------------------------------------------------------------------------
describe("OK verification — a confirmation command is only successful on an OK line", () => {
  it("rejects a SET VAR that is answered with a data line instead of OK", async () => {
    const mock = createMockNutServer(cmd => (cmd.startsWith("SET VAR") ? 'VAR ups0 x "1"' : "OK"));
    const port = await mock.start();
    try {
      const client = new NutClient("127.0.0.1", port);
      await client.connect();
      await expect(client.setVar("ups0", "x", "1")).rejects.toMatchObject({ code: "UNEXPECTED-RESPONSE" });
      client.destroy();
    } finally {
      await mock.stop();
    }
  });

  it("rejects USERNAME/PASSWORD answered with anything but OK", async () => {
    const mock = createMockNutServer(cmd => (cmd.startsWith("USERNAME") ? "HELLO" : "OK"));
    const port = await mock.start();
    try {
      const client = new NutClient("127.0.0.1", port);
      await client.connect();
      await expect(client.authenticate("admin", "secret")).rejects.toMatchObject({ code: "UNEXPECTED-RESPONSE" });
      client.destroy();
    } finally {
      await mock.stop();
    }
  });

  it("accepts OK with a trailer (INSTCMD tracking, STARTTLS)", async () => {
    const mock = createMockNutServer(cmd => (cmd.startsWith("INSTCMD") ? "OK TRACKING 4711" : "OK"));
    const port = await mock.start();
    try {
      const client = new NutClient("127.0.0.1", port);
      await client.connect();
      await expect(client.instCmd("ups0", "beeper.enable")).resolves.toBeUndefined();
      client.destroy();
    } finally {
      await mock.stop();
    }
  });

  it("does not attempt a TLS handshake when STARTTLS is answered with a non-OK line", async () => {
    const mock = createMockNutServer(cmd => (cmd === "STARTTLS" ? "FOO" : "OK"));
    const port = await mock.start();
    try {
      const client = new NutClient("127.0.0.1", port, { useTls: true });
      await expect(client.connect()).rejects.toMatchObject({ code: "UNEXPECTED-RESPONSE" });
      expect(client.isTls).toBe(false);
      client.destroy();
    } finally {
      await mock.stop();
    }
  });

  it("sends the credential sequence and the LOGOUT in order", async () => {
    // No client-side login bookkeeping any more: the getter that used to track it was the last
    // remnant of design #30 (a permanent LOGIN on the live connection), which #32 reversed —
    // nothing in production ever read it. What has to hold is the wire sequence.
    const mock = createMockNutServer(cmd => (cmd === "LOGOUT" ? "OK Goodbye" : "OK"));
    const port = await mock.start();
    try {
      const client = new NutClient("127.0.0.1", port);
      await client.connect();
      await client.authenticate("admin", "secret");
      await client.login("ups0");
      await client.logout();
      expect(mock.commands).toEqual(["USERNAME admin", "PASSWORD secret", "LOGIN ups0", "LOGOUT"]);
      client.destroy();
    } finally {
      await mock.stop();
    }
  });
});

describe("TLS CA file — strict check against a private CA", () => {
  const writeTmp = (name: string, content: string): string => {
    const file = path.join(os.tmpdir(), `nut2-test-${process.pid}-${name}`);
    fs.writeFileSync(file, content);
    return file;
  };

  it(
    "trusts the server certificate through the configured CA file with verification ON",
    { timeout: 10000 },
    async () => {
      const mock = createStartTlsMockServer(cmd =>
        cmd === "LIST UPS" ? ["BEGIN LIST UPS", 'UPS ups0 "Secure"', "END LIST UPS"] : "OK",
      );
      const port = await mock.start();
      const caFile = writeTmp("ca.pem", TEST_TLS_CERT);
      try {
        const client = new NutClient("127.0.0.1", port, {
          useTls: true,
          tlsRejectUnauthorized: true,
          tlsCaFile: caFile,
        });
        await client.connect();
        expect(client.isTls).toBe(true);
        expect(await client.listUps()).toEqual([{ name: "ups0", description: "Secure" }]);
        client.destroy();
      } finally {
        fs.rmSync(caFile, { force: true });
        await mock.stop();
      }
    },
  );

  it("a missing CA file is a fatal configuration error — checked before STARTTLS is even sent", async () => {
    const mock = createStartTlsMockServer(() => "OK");
    const port = await mock.start();
    try {
      const client = new NutClient("127.0.0.1", port, {
        useTls: true,
        tlsRejectUnauthorized: true,
        tlsCaFile: path.join(os.tmpdir(), "nut2-does-not-exist.pem"),
      });
      let caught: unknown;
      await client.connect().catch((e: unknown) => (caught = e));
      expect((caught as NutError).code).toBe("TLS-CA-UNREADABLE");
      expect(isTlsConfigError(caught)).toBe(true);
      expect(mock.commands).not.toContain("STARTTLS");
      client.destroy();
    } finally {
      await mock.stop();
    }
  });

  it("a broken CA path is harmless while the strict check is off — the file is never read", async () => {
    // The admin only HIDES the CA field when "Require valid certificate" is off; the stored path
    // stays. Reading it anyway made a moved/deleted PEM fatal on a connection that does not verify
    // any certificate at all — the adapter went yellow with no retry over an unused file.
    const mock = createStartTlsMockServer(cmd =>
      cmd === "LIST UPS" ? ["BEGIN LIST UPS", 'UPS ups0 "Secure"', "END LIST UPS"] : "OK",
    );
    const port = await mock.start();
    const debug: string[] = [];
    try {
      const client = new NutClient("127.0.0.1", port, {
        useTls: true,
        tlsRejectUnauthorized: false,
        tlsCaFile: path.join(os.tmpdir(), "nut2-does-not-exist.pem"),
        logger: { debug: m => debug.push(m), warn: () => {}, info: () => {} },
      });
      await client.connect();
      expect(client.isTls).toBe(true);
      expect(await client.listUps()).toEqual([{ name: "ups0", description: "Secure" }]);
      // Not silently dead: the line says why the configured path did nothing, so re-enabling the
      // strict check later does not resurrect the fatal error out of nowhere.
      expect(debug.some(m => m.includes("nut2-does-not-exist.pem") && m.includes("is configured but not used"))).toBe(
        true,
      );
      client.destroy();
    } finally {
      await mock.stop();
    }
  });

  it("a CA file without a PEM certificate is a fatal configuration error", async () => {
    const mock = createStartTlsMockServer(() => "OK");
    const port = await mock.start();
    const caFile = writeTmp("garbage.pem", "this is not a certificate");
    try {
      const client = new NutClient("127.0.0.1", port, { useTls: true, tlsRejectUnauthorized: true, tlsCaFile: caFile });
      let caught: unknown;
      await client.connect().catch((e: unknown) => (caught = e));
      expect((caught as NutError).code).toBe("TLS-CA-INVALID");
      expect(isTlsConfigError(caught)).toBe(true);
      client.destroy();
    } finally {
      fs.rmSync(caFile, { force: true });
      await mock.stop();
    }
  });
});

describe("isTlsConfigError", () => {
  it("treats OpenSSL parse errors (a broken CA/certificate) as fatal configuration errors", () => {
    expect(isTlsConfigError({ code: "ERR_OSSL_PEM_NO_START_LINE" })).toBe(true);
    expect(isTlsConfigError({ code: "ECONNRESET" })).toBe(false);
  });

  it("treats NUT no-TLS / SSL-mode errors as fatal", () => {
    expect(isTlsConfigError(new NutError("FEATURE-NOT-CONFIGURED"))).toBe(true);
    expect(isTlsConfigError(new NutError("FEATURE-NOT-SUPPORTED"))).toBe(true);
    expect(isTlsConfigError(new NutError("ALREADY-SSL-MODE"))).toBe(true);
  });

  it("treats certificate-verification errors as fatal", () => {
    expect(isTlsConfigError({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" })).toBe(true);
    expect(isTlsConfigError({ code: "SELF_SIGNED_CERT_IN_CHAIN" })).toBe(true);
    expect(isTlsConfigError({ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" })).toBe(true);
    expect(isTlsConfigError({ code: "CERT_HAS_EXPIRED" })).toBe(true);
    expect(isTlsConfigError({ code: "ERR_TLS_CERT_ALTNAME_INVALID" })).toBe(true);
    expect(isTlsConfigError({ code: "ERR_SSL_WRONG_VERSION_NUMBER" })).toBe(true);
  });

  it("does NOT treat transient network errors (or other NUT errors) as fatal", () => {
    expect(isTlsConfigError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))).toBe(false);
    expect(isTlsConfigError(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))).toBe(false);
    expect(isTlsConfigError(new NutError("ACCESS-DENIED"))).toBe(false);
  });

  it("handles errors without a string code", () => {
    expect(isTlsConfigError(null)).toBe(false);
    expect(isTlsConfigError(undefined)).toBe(false);
    expect(isTlsConfigError("boom")).toBe(false);
    expect(isTlsConfigError(new Error("no code"))).toBe(false);
    expect(isTlsConfigError({ code: 42 })).toBe(false);
  });
});

describe("NutClient credential redaction", () => {
  it("should not log plaintext username or password at debug level", async () => {
    const debugLogs: string[] = [];
    const logger = {
      debug: (m: string) => debugLogs.push(m),
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    const mock = createMockNutServer(cmd =>
      cmd.startsWith("USERNAME") || cmd.startsWith("PASSWORD") ? "OK" : "ERR UNKNOWN-COMMAND",
    );
    const port = await mock.start();
    const client = new NutClient("127.0.0.1", port, { logger });
    try {
      await client.connect();
      await client.authenticate("secretuser", "s3cr3t-pw");
      expect(debugLogs.some(l => l.includes("s3cr3t-pw"))).toBe(false);
      expect(debugLogs.some(l => l.includes("secretuser"))).toBe(false);
      expect(debugLogs).toContain(">> USERNAME ***");
      expect(debugLogs).toContain(">> PASSWORD ***");
    } finally {
      client.destroy();
      await mock.stop();
    }
  });
});

describe("authFailureText", () => {
  it("names both causes of ACCESS-DENIED — upsd cannot tell them apart on the wire", () => {
    const text = authFailureText(new NutError("ACCESS-DENIED"));
    expect(text).toContain("wrong password");
    expect(text).toContain("upsd.users");
  });

  it("names the code for the other credential refusals", () => {
    // The branch that was never exercised: every AUTH code that is not ACCESS-DENIED.
    for (const code of ["INVALID-USERNAME", "INVALID-PASSWORD", "USERNAME-REQUIRED", "ALREADY-SET-PASSWORD"]) {
      expect(authFailureText(new NutError(code))).toContain(code);
    }
  });

  it("returns null for anything that is not about credentials", () => {
    expect(authFailureText(new NutError("DATA-STALE"))).toBeNull();
    expect(authFailureText(new Error("ACCESS-DENIED"))).toBeNull();
    expect(authFailureText("ACCESS-DENIED")).toBeNull();
  });
});
