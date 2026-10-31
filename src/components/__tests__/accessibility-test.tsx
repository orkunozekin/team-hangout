import React from "react";
import { render, screen } from "@testing-library/react-native";
import { PrimaryButton, SecondaryButton, FieldError, Title, TITLE_MAX_FONT_SCALE } from "../ui";

describe("shared accessibility semantics", () => {
  it.each([PrimaryButton, SecondaryButton])(
    "keeps its name, disabled and busy state while loading",
    async (Button) => {
      await render(
        <Button label="Save contact details" loading onPress={() => {}} />,
      );
      const action = screen.getByRole("button", {
        name: "Save contact details",
      });
      expect(action.props.accessibilityState).toEqual({
        disabled: true,
        busy: true,
      });
    },
  );
  it("exposes headings and live field errors", async () => {
    await render(
      <>
        <Title>Household</Title>
        <FieldError message="Review your email address" />
      </>,
    );
    expect(screen.getByRole("header")).toBeTruthy();
    expect(screen.getByRole("alert").props.accessibilityLiveRegion).toBe(
      "polite",
    );
  });

  it("caps screen title scaling so words do not split mid-word", async () => {
    await render(<Title>Household</Title>);
    expect(screen.getByRole("header").props.maxFontSizeMultiplier).toBe(TITLE_MAX_FONT_SCALE);
  });
});
