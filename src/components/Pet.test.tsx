import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Pet } from "./Pet";
import { useAppStore } from "@/lib/store";
import { togglePetVisibility } from "@/lib/commands";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: vi.fn((v: string) => `mock://${v}`),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    startDragging: vi.fn(async () => {}),
  })),
}));

vi.mock("@/lib/commands", () => ({
  quitApp: vi.fn(async () => {}),
  togglePetVisibility: vi.fn(async () => {}),
}));

const initialState = useAppStore.getState();

describe("Pet", () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true);
    useAppStore.setState({
      petState: "idle",
      chatOpen: false,
      settingsOpen: false,
      contextMenuOpen: false,
      config: null,
    });
  });

  it("opens context menu and can open settings", async () => {
    const user = userEvent.setup();
    const { container } = render(<Pet size={100} />);
    const petNode = container.querySelector("img");
    expect(petNode).toBeTruthy();

    await user.pointer([
      {
        target: petNode as Element,
        keys: "[MouseRight]",
      },
    ]);

    await user.click(screen.getByRole("button", { name: "⚙️ 设置" }));
    expect(useAppStore.getState().settingsOpen).toBe(true);
  });

  it("supports hide action from pet context menu", async () => {
    const user = userEvent.setup();
    const { container } = render(<Pet size={100} />);
    const petNode = container.querySelector("img");
    expect(petNode).toBeTruthy();

    await user.pointer([
      {
        target: petNode as Element,
        keys: "[MouseRight]",
      },
    ]);

    const hideButtons = screen.getAllByRole("button", { name: "🙈 隐藏 / 显示" });
    await user.click(hideButtons[0]);
    expect(togglePetVisibility).toHaveBeenCalledTimes(1);
  });
});
