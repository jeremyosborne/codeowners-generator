import fs from 'fs';
import { stripIndents } from 'common-tags';
import parseGlob from 'parse-glob';
import { MAINTAINERS_EMAIL_PATTERN, contentTemplate, CONTENT_MARK, CHARACTER_RANGE_PATTERN } from './constants';
import { dirname, join } from 'path';
import { readContent } from './readContent';
import { logger } from '../utils/debug';

const debug = logger('utils/codeowners');

const isString = (x: unknown): x is string => {
  return typeof x === 'string';
};

const isObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object';

export type ownerRule = {
  filePath: string;
  owners: string[];
  glob: string;
};

const filterGeneratedContent = (content: string) => {
  const lines = content.split('\n');

  let skip = false;
  return lines
    .reduce((memo, line) => {
      if (line === CONTENT_MARK) {
        skip = !skip;
        return memo;
      }

      return skip ? memo : [...memo, line];
    }, [] as string[])
    .join('\n');
};
export const createOwnersFile = async (outputFile: string, ownerRules: ownerRule[]): Promise<void> => {
  let originalContent = '';

  if (fs.existsSync(outputFile)) {
    debug(`output file ${outputFile} exists, extracting content before overwriting`);
    originalContent = await readContent(outputFile);
    originalContent = filterGeneratedContent(originalContent);
  }

  const content = ownerRules.map(
    (rule) => stripIndents` 
    # Rule extracted from ${rule.filePath}
    ${rule.glob} ${rule.owners.join(' ')}
    `
  );

  fs.writeFileSync(outputFile, contentTemplate(content.join('\n'), originalContent));
};

const parseCodeOwner = (filePath: string, codeOwnerContent: string): ownerRule[] => {
  const content = codeOwnerContent.split('\n');

  // TODO: include comments optionally.
  const filteredRules = content.filter((line) => line && !line.startsWith('#'));

  return filteredRules.map((rule) => ({ filePath, ...createMatcherCodeownersRule(filePath, rule) }));
};

const isValidCodeownersGlob = (glob: string) => {
  if (typeof glob !== 'string' || glob.length <= 0) {
    // A pattern must be string and cannot be empty
    return false;
  }
  const parsedGlob = parseGlob(glob);

  // These controls are based on the Github CODEOWNERS syntax documentation
  // https://docs.github.com/en/github/creating-cloning-and-archiving-repositories/about-code-owners#codeowners-syntax
  // as well as the gitignore pattern format which it extends
  // https://git-scm.com/docs/gitignore#_pattern_format

  if (parsedGlob.is.negated) {
    // A pattern cannot use ! to negate
    return false;
  }
  if (parsedGlob.is.braces) {
    // A pattern cannot use { } for brace expansion or brace sets
    return false;
  }
  if (glob.startsWith('\\#')) {
    // A pattern cannot start with an escaped # using \ so it is treated as a pattern and not a comment
    return false;
  }
  if (parsedGlob.is.glob && CHARACTER_RANGE_PATTERN.test(parsedGlob.glob)) {
    // A pattern cannot use [ ] to define a character range
    return false;
  }

  return true;
};

const createMatcherCodeownersRule = (filePath: string, rule: string) => {
  const parts = rule.split(/\s+/);
  const [glob, ...owners] = parts;

  if (owners.length && isValidCodeownersGlob(glob)) {
    return {
      glob: join(dirname(filePath), glob),
      owners,
    };
  } else {
    throw new Error(`${rule} in ${filePath} can not be parsed`);
  }
};
export const loadCodeOwnerFiles = async (dirname: string, files: string[]): Promise<ownerRule[]> => {
  const codeOwners = await Promise.all(
    files.map(async (filePath) => {
      const content = await readContent(filePath);

      return parseCodeOwner(filePath.replace(`${dirname}/`, ''), content);
    })
  );
  return codeOwners.reduce((memo, rules) => [...memo, ...rules], []);
};

interface PACKAGE {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  maintainers: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contributors: any[];
  author?: Record<string, string>;
}

const getOwnersFromMaintainerField = (filePath: string, content: string): ownerRule => {
  try {
    const { maintainers = [], contributors = [], author } = JSON.parse(content) as PACKAGE;

    const packageOwners = [...maintainers, ...contributors];

    if (author) {
      packageOwners.unshift(author);
    }

    let owners = [] as string[];
    if (packageOwners.length) {
      owners = packageOwners.reduce((memo, maintainer) => {
        if (isString(maintainer)) {
          const matches = maintainer.match(MAINTAINERS_EMAIL_PATTERN);
          if (matches?.length) return [...memo, matches[1]];
        } else if (isObject(maintainer) && 'email' in maintainer && isString(maintainer.email)) {
          return [...memo, maintainer.email];
        }

        return memo;
      }, [] as string[]);

      if (!owners.length) {
        throw new Error(
          `malformed maintainer entry ${maintainers} this file will be skipped. for more info https://classic.yarnpkg.com/en/docs/package-json/#toc-maintainers`
        );
      }

      return {
        filePath,
        glob: `${dirname(filePath)}/`,
        owners,
      };
    } else {
      throw new Error('No maintainers found, this file will be skipped.');
    }
  } catch (e) {
    throw new Error(`Parsing ${filePath}: ${e}`);
  }
};
export const loadOwnersFromPackage = async (dirname: string, files: string[]): Promise<ownerRule[]> => {
  const codeOwners = await Promise.all(
    files.map(async (filePath) => {
      const content = await readContent(filePath);

      try {
        return getOwnersFromMaintainerField(filePath.replace(`${dirname}/`, ''), content);
      } catch (e) {
        return undefined;
      }
    })
  );

  // https://github.com/microsoft/TypeScript/issues/30621
  return codeOwners.filter(Boolean) as ownerRule[];
};
