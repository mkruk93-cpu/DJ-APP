"use client";

import React, { forwardRef, useMemo } from "react";

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, "autoComplete"> & {
  autoComplete?: string;
};

export const NoAutofillInput = forwardRef<HTMLInputElement, Props>(function NoAutofillInput(
  { onFocus, onBlur, autoComplete, type = "text", ...rest },
  ref,
) {
  const effectiveAutoComplete = useMemo(() => {
    return autoComplete ?? "off";
  }, [autoComplete]);

  const effectiveType = useMemo(() => {
    return type === "text" ? "search" : type;
  }, [type]);

  return (
    <input
      ref={ref}
      {...rest}
      type={effectiveType}
      autoComplete={effectiveAutoComplete}
      autoCorrect={(rest as any).autoCorrect ?? "off"}
      autoCapitalize={(rest as any).autoCapitalize ?? "off"}
      inputMode={(rest as any).inputMode ?? "text"}
      aria-autocomplete={(rest as any)["aria-autocomplete"] ?? "none"}
      data-lpignore="true"
      data-1p-ignore="true"
      data-form-type="other"
      role="combobox"
      onFocus={onFocus}
      onBlur={onBlur}
    />
  );
});
