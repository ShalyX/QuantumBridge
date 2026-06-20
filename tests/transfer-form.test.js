import assert from 'node:assert/strict';
import test from 'node:test';
import { clearTransferInputs } from '../src/transfer-form.js';

test('successful transfer cleanup clears amount and manual recipient', () => {
    const amountInput = { value: '19.666' };
    const destinationAddressInput = { value: '0xc2094270de7d17c1578a975dd1aa5f0578c034be4' };
    let destinationSyncs = 0;

    clearTransferInputs({
        amountInput,
        destinationAddressInput,
        onDestinationChange: () => { destinationSyncs += 1; },
    });

    assert.equal(amountInput.value, '');
    assert.equal(destinationAddressInput.value, '');
    assert.equal(destinationSyncs, 1);
});

test('successful transfer cleanup tolerates optional destination controls', () => {
    const amountInput = { value: '5' };
    assert.doesNotThrow(() => clearTransferInputs({ amountInput }));
    assert.equal(amountInput.value, '');
});
