/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { createFilterOptions } from '@mui/material/Autocomplete'
import { recipientLabel, type RecipientValue } from './recipient-values'

/**
 * Popup filter for the user pickers. The default Autocomplete filter matches
 * the typed text against the option LABEL only, which here is the display
 * name, so typing an address would show "No options" while the field promises
 * "Search by name or email". Stringifying label + address keeps both
 * searchable, which matters most for users used to the old free-text fields.
 */
export const filterRecipientOptions = createFilterOptions<RecipientValue>({
  stringify: (option) => `${recipientLabel(option)} ${option.email}`,
})
