import {validAdmissionPolicy} from '../authority/validator.mjs';

export const defaultAdmissionPolicy = Object.freeze({kind:'allMinusOne', fixedCount:null});

export function requireAdmissionPolicy(policy, adultCount) {
  if (!validAdmissionPolicy(policy, adultCount)) {
    throw Error(`Choose a rule with a whole number of required approvals between 1 and ${adultCount}.`);
  }
  return structuredClone(policy);
}

/** @param {unknown} [policy] */
export function initialAdmissionPolicy(policy) {
  return requireAdmissionPolicy(policy === undefined ? defaultAdmissionPolicy : policy, 1);
}
