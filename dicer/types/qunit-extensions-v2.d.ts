// QUnit extensions not included in DefinitelyTyped
// This file contains missing QUnit methods that are in newer versions

declare global {
    interface Assert {
        /**
         * Compares a number to a target number within a specified tolerance.
         * 
         * Added in QUnit 2.21.0. Useful for comparing floating-point numbers
         * due to JavaScript's number representation limitations.
         *
         * @param actual Expression being tested
         * @param expected Known target number  
         * @param delta Maximum allowed difference between actual and expected
         * @param {string} [message] Short description of the assertion
         */
        closeTo(actual: number, expected: number, delta: number, message?: string): void;
    }
}

export {};