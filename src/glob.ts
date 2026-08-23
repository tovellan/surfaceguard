const REGEX_SPECIAL = new Set(['\\', '^', '$', '.', '+', '(', ')', '|', '{', '}']);

export function globToRegExp(glob: string): RegExp {
  let source = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index] ?? '';
    if (character === '*') {
      if (glob[index + 1] === '*') {
        index += 1;
        if (glob[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else if (character === '[') {
      const end = glob.indexOf(']', index + 1);
      if (end > index + 1) {
        const content = glob.slice(index + 1, end).replace(/^!/u, '^');
        source += `[${content.replaceAll('\\', '\\\\')}]`;
        index = end;
      } else {
        source += '\\[';
      }
    } else {
      source += REGEX_SPECIAL.has(character) ? `\\${character}` : character;
    }
  }
  return new RegExp(`${source}$`, 'u');
}

export function matchesGlob(value: string, glob: string): boolean {
  return globToRegExp(glob).test(value);
}
