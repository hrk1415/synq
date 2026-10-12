'use client';

import { useState, useEffect } from 'react';
import { FolderGit2 } from 'lucide-react';

export interface ProjectThumbnailProps {
  src?: string | null;
  alt?: string;
  size?: 'sm' | 'md' | 'lg' | 'tile';
  theme?: 'dark' | 'light';
  className?: string;
}

/**
 * Clean project thumbnail with graceful fallback icon
 * for missing, invalid, or broken image URLs.
 */
export function ProjectThumbnail({
  src,
  alt = 'Project',
  size = 'md',
  theme = 'dark',
  className = '',
}: ProjectThumbnailProps) {
  const [hasError, setHasError] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setHasError(false);
    setLoaded(false);
  }, [src]);

  const cleanSrc = typeof src === 'string' ? src.trim() : '';
  const isSafeUrl = cleanSrc.startsWith('http://') || cleanSrc.startsWith('https://');
  const showImage = Boolean(cleanSrc && isSafeUrl && !hasError);

  const sizeClasses =
    size === 'tile'
      ? 'w-[52px] h-[52px] rounded-xl'
      : size === 'sm'
      ? 'w-7 h-7 rounded-md'
      : size === 'lg'
      ? 'w-10 h-10 rounded-xl'
      : 'w-8 h-8 rounded-lg';

  const iconSize = size === 'tile' ? 22 : size === 'sm' ? 13 : size === 'lg' ? 18 : 15;
  const isLight = theme === 'light';

  return (
    <div
      data-testid="project-thumbnail"
      className={`${sizeClasses} shrink-0 overflow-hidden ${
        isLight ? 'border border-[#E0E0E0] bg-[#FFFFFF]' : 'border border-[#383838] bg-[#1B1B1B]'
      } flex items-center justify-center relative select-none ${className}`}
    >
      {showImage && (
        <img
          src={cleanSrc}
          alt={alt || 'Project thumbnail'}
          className={`w-full h-full object-cover transition-opacity duration-150 ${
            loaded ? 'opacity-100' : 'opacity-0'
          }`}
          onLoad={() => setLoaded(true)}
          onError={() => setHasError(true)}
          loading="lazy"
          decoding="async"
        />
      )}
      {(!showImage || !loaded) && (
        <div
          data-testid="project-thumbnail-fallback"
          className={`absolute inset-0 flex items-center justify-center ${
            isLight ? 'text-[#171717] bg-[#F5F5F5]' : 'text-[#A3A3A3] bg-[#252525]'
          }`}
        >
          <FolderGit2 size={iconSize} className={isLight ? 'text-[#171717]' : 'text-[#A3A3A3]'} />
        </div>
      )}
    </div>
  );
}
