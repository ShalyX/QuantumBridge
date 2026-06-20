export function clearTransferInputs({
    amountInput,
    destinationAddressInput,
    onDestinationChange,
} = {}) {
    if (amountInput) amountInput.value = '';
    if (destinationAddressInput) destinationAddressInput.value = '';
    onDestinationChange?.();
}
