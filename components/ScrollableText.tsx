"use client";

import { useEffect, useRef, useState } from "react";

interface ScrollableTextProps {
  text: string;
  className?: string;
  children?: React.ReactNode;
}

export default function ScrollableText({ text, className = "", children }: ScrollableTextProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [shouldScroll, setShouldScroll] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    const textElement = textRef.current;
    
    if (!container || !textElement) return;

    const checkOverflow = () => {
      const isOverflowing = textElement.scrollWidth > container.clientWidth;
      setShouldScroll(isOverflowing);
    };

    checkOverflow();
    window.addEventListener('resize', checkOverflow);
    
    return () => {
      window.removeEventListener('resize', checkOverflow);
    };
  }, [text, children]);

  useEffect(() => {
    if (!shouldScroll || isPaused) return;

    const container = containerRef.current;
    if (!container) return;

    const scrollAnimation = () => {
      if (container.scrollLeft >= container.scrollWidth - container.clientWidth) {
        container.scrollLeft = 0;
      } else {
        container.scrollLeft += 1;
      }
    };

    const interval = setInterval(scrollAnimation, 30);
    
    return () => clearInterval(interval);
  }, [shouldScroll, isPaused]);

  if (children) {
    return (
      <div 
        ref={containerRef}
        className={`overflow-hidden ${className}`}
        onMouseEnter={() => setIsPaused(true)}
        onMouseLeave={() => setIsPaused(false)}
      >
        <div 
          ref={textRef}
          className={`inline-block ${shouldScroll ? 'animate-none' : ''}`}
          style={shouldScroll ? { whiteSpace: 'nowrap' } : {}}
        >
          {children}
        </div>
      </div>
    );
  }

  return (
    <div 
      ref={containerRef}
      className={`overflow-hidden ${className}`}
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
    >
      <div 
        ref={textRef}
        className={`inline-block ${shouldScroll ? 'animate-none' : ''}`}
        style={shouldScroll ? { whiteSpace: 'nowrap' } : {}}
      >
        {text}
      </div>
    </div>
  );
}
