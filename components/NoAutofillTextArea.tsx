"use client";

import React, { forwardRef, useCallback, useMemo, useState } from "react";

type Props = Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "autoComplete"> & {
  autoComplete?: string;
};

export const NoAutofillTextArea = forwardRef<HTMLTextAreaElement, Props>(function NoAutofillTextArea(
  { onFocus, onBlur, autoComplete, readOnly, rows, ...rest },
  ref,
) {
  const [ro, setRo] = useState(true);

  const effectiveAutoComplete = useMemo(() => {
    return autoComplete ?? "off";
  }, [autoComplete]);

  const handleFocus = useCallback(
    (e: React.FocusEvent<HTMLTextAreaElement>) => {
      requestAnimationFrame(() => setRo(false));
      onFocus?.(e);
    },
    [onFocus],
  );

  const handleBlur = useCallback(
    (e: React.FocusEvent<HTMLTextAreaElement>) => {
      setRo(true);
      onBlur?.(e);
    },
    [onBlur],
  );

  return (
    <textarea
      ref={ref}
      {...rest}
      rows={rows ?? 1}
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

