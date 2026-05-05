import { describe, expect, it } from "vitest";

import {
  buildEmbeddingProvider,
  resolveEmbeddingConfig,
} from "@/llm/embeddings/factory";
import { EmbeddingConfigurationError } from "@/llm/embeddings/base";
import { MockEmbeddingProvider } from "@/llm/embeddings/mock";
import { LocalEmbeddingProvider } from "@/llm/embeddings/local";
import { OpenAICompatEmbeddingProvider } from "@/llm/embeddings/openai_compat";
import {
  type LibraryLlmConfigRow,
  DEFAULT_EMBEDDING_CONFIG,
} from "@/db/schema";

function libraryRow(
  patch: Partial<LibraryLlmConfigRow> = {},
): LibraryLlmConfigRow {
  return {
    key: "llm",
    base_url: "https://api.example.com/v1",
    api_key: "sk-test",
    model: "gpt-5-mini",
    helper_model: null,
    organization: null,
    reasoning_effort: null,
    pricing_overrides: {},
    embedding: DEFAULT_EMBEDDING_CONFIG,
    ...patch,
  };
}

describe("resolveEmbeddingConfig", () => {
  it("returns null when provider is none (the default)", () => {
    expect(resolveEmbeddingConfig(libraryRow())).toBeNull();
  });

  it("library override flips provider to openai-compat with the LLM endpoint as fallback", () => {
    const cfg = resolveEmbeddingConfig(
      libraryRow({
        embedding: {
          ...DEFAULT_EMBEDDING_CONFIG,
          provider: "openai-compat",
        },
      }),
    );
    expect(cfg).not.toBeNull();
    expect(cfg!.provider).toBe("openai-compat");
    expect(cfg!.model).toBe("text-embedding-3-small");
    expect(cfg!.dim).toBe(1536);
    expect(cfg!.base_url).toBe("https://api.example.com/v1");
    expect(cfg!.api_key).toBe("sk-test");
  });

  it("dedicated embedding base_url + api_key win over the LLM endpoint", () => {
    const cfg = resolveEmbeddingConfig(
      libraryRow({
        embedding: {
          ...DEFAULT_EMBEDDING_CONFIG,
          provider: "openai-compat",
          base_url: "https://embeddings.example.com/v1",
          api_key: "sk-embed",
          model: "voyage-3",
          dim: 1024,
        },
      }),
    );
    expect(cfg!.base_url).toBe("https://embeddings.example.com/v1");
    expect(cfg!.api_key).toBe("sk-embed");
    expect(cfg!.model).toBe("voyage-3");
    expect(cfg!.dim).toBe(1024);
  });

  it("project overrides win over the library config", () => {
    const cfg = resolveEmbeddingConfig(
      libraryRow({
        embedding: {
          ...DEFAULT_EMBEDDING_CONFIG,
          provider: "openai-compat",
          model: "text-embedding-3-small",
          dim: 1536,
        },
      }),
      {
        provider: "openai-compat",
        model: "text-embedding-3-large",
        dim: 3072,
        batch_size: 32,
      },
    );
    expect(cfg!.model).toBe("text-embedding-3-large");
    expect(cfg!.dim).toBe(3072);
    expect(cfg!.batch_size).toBe(32);
  });

  it("project override of provider=none disables a library-enabled embedding", () => {
    const cfg = resolveEmbeddingConfig(
      libraryRow({
        embedding: {
          ...DEFAULT_EMBEDDING_CONFIG,
          provider: "openai-compat",
        },
      }),
      { provider: "none" },
    );
    expect(cfg).toBeNull();
  });

  it("rejects openai-compat without any base_url anywhere", () => {
    expect(() =>
      resolveEmbeddingConfig(
        libraryRow({
          base_url: "",
          embedding: {
            ...DEFAULT_EMBEDDING_CONFIG,
            provider: "openai-compat",
            base_url: null,
          },
        }),
      ),
    ).toThrow(EmbeddingConfigurationError);
  });

  it("rejects unknown provider names", () => {
    expect(() =>
      resolveEmbeddingConfig(
        libraryRow({
          embedding: {
            ...DEFAULT_EMBEDDING_CONFIG,
            // @ts-expect-error — exercising the runtime guard
            provider: "wishful-thinking",
          },
        }),
      ),
    ).toThrow(EmbeddingConfigurationError);
  });
});

describe("buildEmbeddingProvider", () => {
  it("mock=true returns the deterministic mock provider", async () => {
    const result = await buildEmbeddingProvider({ mock: true });
    expect(result.provider).toBeInstanceOf(MockEmbeddingProvider);
    expect(result.resolved).toBeNull();
  });

  it("returns null when embeddings are disabled", async () => {
    const result = await buildEmbeddingProvider({
      configOverride: libraryRow(),
    });
    expect(result.provider).toBeNull();
    expect(result.resolved).toBeNull();
  });

  it("builds an OpenAI-compat provider when the library opts in", async () => {
    const result = await buildEmbeddingProvider({
      configOverride: libraryRow({
        embedding: {
          ...DEFAULT_EMBEDDING_CONFIG,
          provider: "openai-compat",
        },
      }),
    });
    expect(result.provider).toBeInstanceOf(OpenAICompatEmbeddingProvider);
    expect(result.resolved?.provider).toBe("openai-compat");
    expect(result.provider!.model).toBe("text-embedding-3-small");
  });

  it("builds a LocalEmbeddingProvider when the library opts in", async () => {
    const result = await buildEmbeddingProvider({
      configOverride: libraryRow({
        embedding: {
          ...DEFAULT_EMBEDDING_CONFIG,
          provider: "local",
          model: "Xenova/multilingual-e5-small",
          dim: 384,
        },
      }),
    });
    expect(result.provider).toBeInstanceOf(LocalEmbeddingProvider);
    expect(result.resolved?.provider).toBe("local");
  });
});
