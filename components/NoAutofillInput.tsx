"use client";

import React, { forwardRef, useCallback, useMemo, useState } from "react";

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, "autoComplete"> & {
  autoComplete?: string;
};

export const NoAutofillInput = forwardRef<HTMLInputElement, Props>(function NoAutofillInput(
  { onFocus, onBlur, autoComplete, readOnly, ...rest },
  ref,
) {
  const [ro, setRo] = useState(true);

  const effectiveAutoComplete = useMemo(() => {
    return autoComplete ?? "off";
  }, [autoComplete]);

  const handleFocus = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      requestAnimationFrame(() => setRo(false));
      onFocus?.(e);
    },
    [onFocus],
  );

  const handleBlur = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      setRo(true);
      onBlur?.(e);
    },
    [onBlur],
  );

  return (
    <input
      ref={ref}
      {...rest}
      autoComplete={effectiveAutoComplete}
      autoCorrect={(rest as any).autoCorrect ?? "off"}
      autoCapitalize={(rest as any).autoCapitalize ?? "none"}
      inputMode={(rest as any).inputMode ?? "text"}
      aria-autocomplete={(rest as any)["aria-autocomplete"] ?? "none"}
      readOnly={!!readOnly || ro}
      onFocus={handleFocus}
      onBlur={handleBlur}
    />
  );
});
