import {readFileSync} from 'node:fs';
import {App} from 'aws-cdk-lib';

// cdk.json's feature flags, so a test synthesizes what a deploy does; an empty bundling list
// skips bundling, since these tests read the templates, not the code.
const {context} = JSON.parse(readFileSync(new URL('../../cdk.json', import.meta.url), 'utf8'));

export const makeApp = () => new App({context: {...context, 'aws:cdk:bundling-stacks': []}});
