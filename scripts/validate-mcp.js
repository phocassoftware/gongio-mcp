#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import AjvModule from 'ajv';
import addFormatsModule from 'ajv-formats';

const Ajv = AjvModule.default ?? AjvModule;
const addFormats = addFormatsModule.default ?? addFormatsModule;

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const server = JSON.parse(readFileSync('server.json', 'utf8'));

const errors = [];

console.log('Validating server.json against MCP schema...');
try {
    const schemaUrl =
        server.$schema ||
        'https://static.modelcontextprotocol.io/schemas/2025-10-17/server.schema.json';
    const schemaResponse = await fetch(schemaUrl);
    const schema = await schemaResponse.json();

    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const valid = validate(server);

    if (!valid && validate.errors) {
        errors.push('server.json failed schema validation:');
        for (const err of validate.errors) {
            errors.push(`  - ${err.instancePath || 'root'}: ${err.message}`);
        }
    }
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️  Could not fetch schema for validation: ${message}`);
    console.warn('   Continuing with basic validation...\n');
}

console.log('Validating package.json requirements...');

if (!pkg.mcpName) {
    errors.push('package.json is missing required "mcpName" field');
}

if (pkg.mcpName && pkg.mcpName !== server.name) {
    errors.push(
        `package.json mcpName "${pkg.mcpName}" does not match server.json name "${server.name}"`,
    );
}

console.log('Validating version consistency...');

if (pkg.version !== server.version) {
    errors.push(
        `package.json version "${pkg.version}" does not match server.json version "${server.version}"`,
    );
}

if (
    server.packages?.[0]?.version &&
    pkg.version !== server.packages[0].version
) {
    errors.push(
        `package.json version "${pkg.version}" does not match server.json packages[0].version "${server.packages[0].version}"`,
    );
}

if (errors.length > 0) {
    console.error('\n❌ MCP validation failed:\n');
    for (const error of errors) {
        console.error(`  • ${error}`);
    }
    process.exit(1);
}

console.log('\n✅ MCP validation passed');