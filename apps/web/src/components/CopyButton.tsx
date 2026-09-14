'use client';
import { useEffect, useRef, useState } from 'react';
import { copyText } from '@/lib/clipboard';
import { Icon } from './Icon';
export function CopyButton({
  value,
  label = 'Copy',
  text = label,
  className = 'btn secondary small',
}: {
  value: string;
  label?: string;
  text?: string;
  className?: string;
}) {
  const [message, setMessage] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try {
      await copyText(value);
      setMessage('Copied');
    } catch {
      setMessage('Select the text to copy it.');
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(''), 3000);
  }
  return (
    <>
      <button type="button" className={className} onClick={() => void copy()} aria-label={label}>
        <Icon name={message === 'Copied' ? 'check' : 'copy'} size={15} />
        {message === 'Copied' ? 'Copied' : text}
      </button>
      <span className="sr-only" role="status">
        {message}
      </span>
    </>
  );
}
