'use client';

import React from 'react';

interface SafeMarkdownProps {
  content: string;
  className?: string;
}

type Block =
  | { type: 'h2'; text: string }
  | { type: 'h3'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'p'; lines: string[] };

function renderInline(text: string): React.ReactNode {
  // Matches `inline code`, **bold**, *italic*, or _italic_
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_)/g);
  if (parts.length === 1) {
    return text;
  }

  return parts.map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      return (
        <code
          key={index}
          className="rounded bg-zinc-900/90 border border-zinc-700/60 px-1.5 py-0.5 font-mono text-[13px] text-zinc-200"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      return (
        <strong key={index} className="font-semibold text-white">
          {renderInline(part.slice(2, -2))}
        </strong>
      );
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length >= 2) {
      return (
        <em key={index} className="italic text-zinc-200">
          {renderInline(part.slice(1, -1))}
        </em>
      );
    }
    if (part.startsWith('_') && part.endsWith('_') && part.length >= 2) {
      return (
        <em key={index} className="italic text-zinc-200">
          {renderInline(part.slice(1, -1))}
        </em>
      );
    }
    return part;
  });
}

function parseBlocks(content: string): Block[] {
  const lines = content.split('\n');
  const blocks: Block[] = [];
  let currentParagraph: string[] = [];
  let currentList: { type: 'ul' | 'ol'; items: string[] } | null = null;

  const flushParagraph = () => {
    if (currentParagraph.length > 0) {
      blocks.push({ type: 'p', lines: [...currentParagraph] });
      currentParagraph = [];
    }
  };

  const flushList = () => {
    if (currentList) {
      blocks.push(currentList);
      currentList = null;
    }
  };

  const flushAll = () => {
    flushParagraph();
    flushList();
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      flushAll();
      continue;
    }

    // Heading 3: ### Heading
    if (/^###\s+/.test(trimmed)) {
      flushAll();
      blocks.push({ type: 'h3', text: trimmed.replace(/^###\s+/, '') });
      continue;
    }

    // Heading 2: ## Heading
    if (/^##\s+/.test(trimmed)) {
      flushAll();
      blocks.push({ type: 'h2', text: trimmed.replace(/^##\s+/, '') });
      continue;
    }

    // Bullet list item: - item or * item
    const bulletMatch = trimmed.match(/^[-*]\s+(.*)$/);
    if (bulletMatch) {
      flushParagraph();
      if (currentList && currentList.type !== 'ul') {
        flushList();
      }
      if (!currentList) {
        currentList = { type: 'ul', items: [] };
      }
      currentList.items.push(bulletMatch[1]);
      continue;
    }

    // Numbered list item: 1. item
    const orderedMatch = trimmed.match(/^\d+\.\s+(.*)$/);
    if (orderedMatch) {
      flushParagraph();
      if (currentList && currentList.type !== 'ol') {
        flushList();
      }
      if (!currentList) {
        currentList = { type: 'ol', items: [] };
      }
      currentList.items.push(orderedMatch[1]);
      continue;
    }

    // Regular prose line
    flushList();
    currentParagraph.push(line);
  }

  flushAll();
  return blocks;
}

export function SafeMarkdown({ content, className = '' }: SafeMarkdownProps) {
  if (!content || !content.trim()) {
    return null;
  }

  const blocks = parseBlocks(content);

  return (
    <div className={`space-y-2.5 text-sm leading-relaxed text-zinc-200 ${className}`.trim()}>
      {blocks.map((block, idx) => {
        if (block.type === 'h2') {
          return (
            <h3
              key={idx}
              className="text-[15px] font-semibold text-white tracking-tight pt-1 pb-0.5 first:pt-0"
            >
              {renderInline(block.text)}
            </h3>
          );
        }

        if (block.type === 'h3') {
          return (
            <h4
              key={idx}
              className="text-sm font-semibold text-zinc-100 tracking-tight pt-1 pb-0.5 first:pt-0"
            >
              {renderInline(block.text)}
            </h4>
          );
        }

        if (block.type === 'ul') {
          return (
            <ul key={idx} className="list-disc pl-5 space-y-1 my-1 text-zinc-200">
              {block.items.map((item, itemIdx) => (
                <li key={itemIdx} className="leading-relaxed">
                  {renderInline(item)}
                </li>
              ))}
            </ul>
          );
        }

        if (block.type === 'ol') {
          return (
            <ol key={idx} className="list-decimal pl-5 space-y-1 my-1 text-zinc-200">
              {block.items.map((item, itemIdx) => (
                <li key={itemIdx} className="leading-relaxed">
                  {renderInline(item)}
                </li>
              ))}
            </ol>
          );
        }

        return (
          <p key={idx} className="leading-relaxed text-zinc-200">
            {block.lines.map((lineText, lineIdx) => (
              <React.Fragment key={lineIdx}>
                {lineIdx > 0 && <br />}
                {renderInline(lineText)}
              </React.Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
