// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HomeDiscoveryGallery } from "@/components/home-discovery-gallery";
import { homeDiscoverySeedCategories } from "@/lib/home-discovery-seeds";

describe("HomeDiscoveryGallery", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows all discovery cards by default", () => {
    render(
      <HomeDiscoveryGallery
        categories={homeDiscoverySeedCategories}
        onCaseSelect={vi.fn()}
      />,
    );

    expect(screen.getByText("灵感发现")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "The ART & Cultural Arts Center" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Vintage Car Poster" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Cat Tarot Cards" }),
    ).toBeInTheDocument();
  });

  it("filters cards when a category tab is selected", async () => {
    render(
      <HomeDiscoveryGallery
        categories={homeDiscoverySeedCategories}
        onCaseSelect={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "品牌设计" }));

    expect(
      screen.getByRole("button", { name: "The ART & Cultural Arts Center" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Vintage Car Poster" }),
    ).not.toBeInTheDocument();
  });

  it("emits the internal Loomic seed payload when a card is clicked", async () => {
    const onCaseSelect = vi.fn();
    const category = homeDiscoverySeedCategories[0];
    const discoveryCase = category?.cases[0];

    if (!category || !discoveryCase) {
      throw new Error("Expected the branding discovery seed to exist.");
    }

    render(
      <HomeDiscoveryGallery
        categories={homeDiscoverySeedCategories}
        onCaseSelect={onCaseSelect}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "The ART & Cultural Arts Center" }),
    );

    expect(onCaseSelect).toHaveBeenCalledWith({
      ...discoveryCase,
      categoryKey: category.key,
      categoryLabel: category.label,
    });
  });
});
