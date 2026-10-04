import type { AllocateRequest, ValidationIssue } from './types.js';

const isInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v);

/**
 * Validate a parsed request body. Returns the list of issues with field
 * locators (array indices included); an empty list means the request is valid.
 */
export function validateRequest(body: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    issues.push({ field: '$', message: 'request body must be a JSON object' });
    return issues;
  }
  const req = body as Record<string, unknown>;

  // ---- amplicons ----
  const ampliconsPath = 'amplicons';
  if (!Array.isArray(req.amplicons)) {
    issues.push({ field: ampliconsPath, message: 'must be an array' });
  } else {
    const list = req.amplicons;
    if (list.length < 8 || list.length > 18) {
      issues.push({
        field: ampliconsPath,
        message: `must contain between 8 and 18 amplicons (got ${list.length})`,
      });
    }
    const seen = new Map<string, number>();
    list.forEach((item, i) => {
      const p = `${ampliconsPath}[${i}]`;
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        issues.push({ field: p, message: 'must be an object' });
        return;
      }
      const amp = item as Record<string, unknown>;
      if (typeof amp.name !== 'string' || amp.name.trim() === '') {
        issues.push({ field: `${p}.name`, message: 'must be a non-empty string' });
      } else if (seen.has(amp.name)) {
        issues.push({
          field: `${p}.name`,
          message: `duplicate amplicon name "${amp.name}", first seen at index ${seen.get(amp.name)}`,
        });
      } else {
        seen.set(amp.name, i);
      }
      if (!isInt(amp.load) || amp.load <= 0) {
        issues.push({ field: `${p}.load`, message: 'must be a positive integer' });
      }
      if (typeof amp.isControl !== 'boolean') {
        issues.push({ field: `${p}.isControl`, message: 'must be a boolean' });
      }
    });
  }

  // ---- poolCount ----
  if (!('poolCount' in req)) {
    issues.push({ field: 'poolCount', message: 'is required' });
  } else if (!isInt(req.poolCount) || req.poolCount < 2 || req.poolCount > 4) {
    issues.push({ field: 'poolCount', message: 'must be an integer between 2 and 4' });
  }

  // ---- loadRange ----
  if (typeof req.loadRange !== 'object' || req.loadRange === null || Array.isArray(req.loadRange)) {
    issues.push({ field: 'loadRange', message: 'must be an object {min, max}' });
  } else {
    const lr = req.loadRange as Record<string, unknown>;
    if (!isInt(lr.min) || lr.min <= 0) {
      issues.push({ field: 'loadRange.min', message: 'must be a positive integer' });
    }
    if (!isInt(lr.max) || lr.max <= 0) {
      issues.push({ field: 'loadRange.max', message: 'must be a positive integer' });
    }
    if (isInt(lr.min) && isInt(lr.max) && lr.min > lr.max) {
      issues.push({ field: 'loadRange', message: 'min must not exceed max' });
    }
  }

  // ---- hardThreshold ----
  if (!('hardThreshold' in req)) {
    issues.push({ field: 'hardThreshold', message: 'is required' });
  } else if (!isInt(req.hardThreshold) || req.hardThreshold < 0) {
    issues.push({ field: 'hardThreshold', message: 'must be a non-negative integer' });
  }

  // Names known to the amplicon list (shared by riskPairs and preassignments).
  const knownNames = new Set<string>(
    Array.isArray(req.amplicons)
      ? req.amplicons
          .map((a) => (a && typeof a === 'object' ? (a as Record<string, unknown>).name : undefined))
          .filter((n): n is string => typeof n === 'string')
      : [],
  );

  // ---- riskPairs ----
  if (!('riskPairs' in req)) {
    issues.push({ field: 'riskPairs', message: 'is required' });
  } else if (!Array.isArray(req.riskPairs)) {
    issues.push({ field: 'riskPairs', message: 'must be an array' });
  } else {
    const names = knownNames;
    const pairKeys = new Set<string>();
    req.riskPairs.forEach((item, i) => {
      const p = `riskPairs[${i}]`;
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        issues.push({ field: p, message: 'must be an object' });
        return;
      }
      const rp = item as Record<string, unknown>;
      for (const k of ['a', 'b'] as const) {
        if (typeof rp[k] !== 'string' || rp[k] === '') {
          issues.push({ field: `${p}.${k}`, message: 'must be a non-empty amplicon name' });
        } else if (!names.has(rp[k])) {
          issues.push({ field: `${p}.${k}`, message: `unknown amplicon name "${rp[k]}"` });
        }
      }
      if (!isInt(rp.risk) || rp.risk < 0) {
        issues.push({ field: `${p}.risk`, message: 'must be a non-negative integer' });
      }
      if (typeof rp.a === 'string' && typeof rp.b === 'string' && rp.a === rp.b) {
        issues.push({ field: p, message: 'a and b must reference different amplicons' });
      }
      if (typeof rp.a === 'string' && typeof rp.b === 'string' && rp.a !== rp.b) {
        const key = rp.a < rp.b ? `${rp.a}${rp.b}` : `${rp.b}${rp.a}`;
        if (pairKeys.has(key)) {
          issues.push({ field: p, message: `duplicate pair (${rp.a}, ${rp.b}); merge it into one entry` });
        } else {
          pairKeys.add(key);
        }
      }
    });
  }

  // ---- preassignments (optional) ----
  if ('preassignments' in req) {
    if (!Array.isArray(req.preassignments)) {
      issues.push({ field: 'preassignments', message: 'must be an array' });
    } else {
      const list = req.preassignments;
      if (list.length < 1 || list.length > 4) {
        issues.push({
          field: 'preassignments',
          message: `must contain between 1 and 4 preassignments (got ${list.length})`,
        });
      }
      const pc = req.poolCount;
      const poolCount = isInt(pc) && pc >= 2 && pc <= 4 ? pc : null;
      const seen = new Map<string, number>();
      list.forEach((item, i) => {
        const p = `preassignments[${i}]`;
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
          issues.push({ field: p, message: 'must be an object' });
          return;
        }
        const pa = item as Record<string, unknown>;
        if (typeof pa.amplicon !== 'string' || pa.amplicon === '') {
          issues.push({ field: `${p}.amplicon`, message: 'must be a non-empty amplicon name' });
        } else if (!knownNames.has(pa.amplicon)) {
          issues.push({ field: `${p}.amplicon`, message: `unknown amplicon name "${pa.amplicon}"` });
        } else if (seen.has(pa.amplicon)) {
          issues.push({
            field: `${p}.amplicon`,
            message: `duplicate preassigned amplicon "${pa.amplicon}", first seen at index ${seen.get(pa.amplicon)}`,
          });
        } else {
          seen.set(pa.amplicon, i);
        }
        if (!isInt(pa.pool)) {
          issues.push({ field: `${p}.pool`, message: 'must be an integer' });
        } else if (pa.pool < 1 || (poolCount !== null && pa.pool > poolCount)) {
          issues.push({
            field: `${p}.pool`,
            message: `must be a 1-based pool number between 1 and ${poolCount ?? 'poolCount'}`,
          });
        }
      });
    }
  }

  return issues;
}

export function asRequest(body: unknown): AllocateRequest {
  return body as AllocateRequest;
}
