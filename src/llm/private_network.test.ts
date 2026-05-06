/**
 * Unit tests for the Local Network Access classifier.
 *
 * Goal: make sure every URL that an HTTPS deploy on Vercel might be
 * pointed at — local Ollama, an LAN-hosted vLLM, a `.local` mDNS
 * gateway — gets the right `targetAddressSpace` annotation, and that
 * normal cloud endpoints stay untouched (we don't want to send the
 * field on a public OpenAI call where it has no business being).
 */

import { describe, expect, it } from "vitest";

import {
  targetAddressSpaceFor,
  withLnaInit,
} from "./private_network";

describe("targetAddressSpaceFor", () => {
  it("classifies localhost variants as loopback", () => {
    expect(targetAddressSpaceFor("http://localhost:11434/v1")).toBe(
      "loopback",
    );
    expect(targetAddressSpaceFor("http://127.0.0.1:11434/v1")).toBe(
      "loopback",
    );
    expect(targetAddressSpaceFor("http://127.5.6.7/v1")).toBe("loopback");
    expect(targetAddressSpaceFor("http://[::1]:11434/v1")).toBe("loopback");
    // Even an HTTPS loopback: still loopback, even if mixed-content
    // wouldn't bite. Keeps the LNA permission semantics consistent.
    expect(targetAddressSpaceFor("https://localhost:11434/v1")).toBe(
      "loopback",
    );
  });

  it("classifies RFC1918 IPv4 addresses as local", () => {
    expect(targetAddressSpaceFor("http://10.0.0.5:8080/embeddings")).toBe(
      "local",
    );
    expect(targetAddressSpaceFor("http://192.168.1.42/v1")).toBe("local");
    expect(targetAddressSpaceFor("http://172.16.0.1/v1")).toBe("local");
    expect(targetAddressSpaceFor("http://172.31.255.255/v1")).toBe("local");
  });

  it("classifies link-local IPv4 (169.254/16) as local", () => {
    expect(targetAddressSpaceFor("http://169.254.1.1/v1")).toBe("local");
  });

  it("classifies IPv6 ULA + link-local as local", () => {
    expect(
      targetAddressSpaceFor("http://[fc00::1]:11434/v1"),
    ).toBe("local");
    expect(
      targetAddressSpaceFor("http://[fd12:3456::abcd]:11434/v1"),
    ).toBe("local");
    expect(
      targetAddressSpaceFor("http://[fe80::1234]:11434/v1"),
    ).toBe("local");
  });

  it("classifies .local mDNS hostnames as local", () => {
    expect(targetAddressSpaceFor("http://router.local/v1")).toBe("local");
    expect(targetAddressSpaceFor("http://my-mac.local:11434/v1")).toBe(
      "local",
    );
  });

  it("returns null for normal cloud endpoints", () => {
    expect(
      targetAddressSpaceFor("https://api.openai.com/v1/chat/completions"),
    ).toBeNull();
    expect(
      targetAddressSpaceFor("https://api.groq.com/openai/v1"),
    ).toBeNull();
    expect(
      targetAddressSpaceFor(
        "https://my-mac.tailnet.example.ts.net:11434/v1",
      ),
    ).toBeNull();
    // 172.32 is NOT in RFC1918 (only 172.16-172.31 is).
    expect(targetAddressSpaceFor("http://172.32.0.1/v1")).toBeNull();
  });

  it("returns null for malformed URLs (defensive)", () => {
    expect(targetAddressSpaceFor("not a url")).toBeNull();
    expect(targetAddressSpaceFor("")).toBeNull();
  });
});

describe("withLnaInit", () => {
  it("annotates loopback URLs", () => {
    const init = withLnaInit(
      { method: "POST", body: "{}" },
      "http://localhost:11434/v1/chat/completions",
    );
    expect(init).toEqual({
      method: "POST",
      body: "{}",
      targetAddressSpace: "loopback",
    });
  });

  it("annotates private LAN URLs", () => {
    const init = withLnaInit(
      { method: "POST", body: "{}" },
      "http://192.168.1.5/v1/embeddings",
    );
    expect(init.targetAddressSpace).toBe("local");
  });

  it("leaves cloud endpoints unchanged (no targetAddressSpace)", () => {
    const init = withLnaInit(
      { method: "POST", body: "{}" },
      "https://api.openai.com/v1/chat/completions",
    );
    expect(init).toEqual({ method: "POST", body: "{}" });
    expect(init).not.toHaveProperty("targetAddressSpace");
  });

  it("doesn't mutate the caller's init object", () => {
    const original = { method: "POST", body: "{}" };
    const init = withLnaInit(original, "http://localhost:11434/v1");
    expect(original).toEqual({ method: "POST", body: "{}" });
    expect(init).not.toBe(original);
  });
});
