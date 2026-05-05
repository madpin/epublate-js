import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

import "fake-indexeddb/auto";

afterEach(() => {
  cleanup();
});
