/** Class names joined, falsy parts dropped: `cx('dr-btn', primary && 'dr-btn--primary')`. */
export const cx = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(' ')
