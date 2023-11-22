/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import fetch from "node-fetch";

interface Step {
    inline: {
        description: string,
        testData: string,
        expectedResult: string,
        customField: any
    },
    testCase: string
}

interface TestStepResponse {
    isLast: boolean,
    maxResults: number,
    next: any,
    startAt: number,
    total: number,
    values: Step[]
}

export const getTestSteps = async (testID: string): Promise<string[]> => {
    const creds = new DefaultAzureCredential();

    const url = 'https://qa-kv-qateam-north.vault.azure.net';
    const client = new SecretClient(url, creds);
    const token = await client.getSecret('ZephyrToken')
    console.log(token)
    const zephyrToken = token.value ? token.value : ''
    const zephyrUrl = 'https://api.zephyrscale.smartbear.com/v2/testcases/' + testID.replace('_', '-') + '/teststeps';
    const options = {
        method: 'GET',
        headers: {
            Authorization: zephyrToken
        }
    }
    const returnArray: string[] = [];
    await fetch(zephyrUrl, options)
        .then((res) => res.json())
        .then((res) => {
            const steps = (res as TestStepResponse).values;
            const re = /<br \/>/gi;
            for (const s of steps) {
                // console.log(s.inline.description);
                console.log(s.inline.description.replace(re, '\r\n'));
                returnArray.push(s.inline.description.replace(re, '\r\n'))
            }
        });
    return returnArray;
}