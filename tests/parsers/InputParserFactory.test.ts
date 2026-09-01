import { parseInputData, ParseInputOptions } from '../../src/parsers/InputParserFactory';
import { MCPError, ErrorCode } from '../../src/types';
import type { ImportedTask } from '../../src/parsers/JSONParser';

describe('InputParserFactory', () => {
  const validJsonData = JSON.stringify([
    {
      title: 'Test Task 1',
      description: 'Description 1',
      priority: 1,
      done: false,
    },
    {
      title: 'Test Task 2',
      description: 'Description 2',
      priority: 2,
      done: true,
    },
  ]);

  const validCsvData = `title,description,priority,done
Test Task 1,Description 1,1,false
Test Task 2,Description 2,2,true`;

  const csvWithLabels = `title,labels,assignees
Task with labels,label1;label2,user1;user2`;

  describe('parseInputData', () => {
    describe('JSON format parsing', () => {
      it('should parse valid JSON data', () => {
        const options: ParseInputOptions = {
          format: 'json',
          data: validJsonData,
        };

        const { tasks: result } = parseInputData(options);

        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({
          title: 'Test Task 1',
          description: 'Description 1',
          priority: 1,
          done: false,
        });
        expect(result[1]).toEqual({
          title: 'Test Task 2',
          description: 'Description 2',
          priority: 2,
          done: true,
        });
      });

      it('should handle empty JSON array', () => {
        const options: ParseInputOptions = {
          format: 'json',
          data: '[]',
        };

        const { tasks: result } = parseInputData(options);

        expect(result).toHaveLength(0);
      });

      it('should throw MCPError for invalid JSON', () => {
        const options: ParseInputOptions = {
          format: 'json',
          data: 'invalid json',
        };

        expect(() => parseInputData(options)).toThrow(MCPError);
        expect(() => parseInputData(options)).toThrow('Invalid JSON data');
      });

      it('should throw MCPError for JSON with validation errors', () => {
        const options: ParseInputOptions = {
          format: 'json',
          data: JSON.stringify([{ invalidField: 'value' }]),
        };

        expect(() => parseInputData(options)).toThrow(MCPError);
        expect(() => parseInputData(options)).toThrow('Invalid JSON data');
      });

      it('should handle non-array JSON by wrapping in array', () => {
        const options: ParseInputOptions = {
          format: 'json',
          data: JSON.stringify({ title: 'Single task' }),
        };

        const { tasks: result } = parseInputData(options);

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
          title: 'Single task',
        });
      });
    });

    describe('CSV format parsing', () => {
      it('should parse valid CSV data', () => {
        const options: ParseInputOptions = {
          format: 'csv',
          data: validCsvData,
        };

        const { tasks: result } = parseInputData(options);

        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({
          title: 'Test Task 1',
          description: 'Description 1',
          priority: 1,
          done: false,
        });
        expect(result[1]).toEqual({
          title: 'Test Task 2',
          description: 'Description 2',
          priority: 2,
          done: true,
        });
      });

      it('should parse CSV with labels and assignees', () => {
        const options: ParseInputOptions = {
          format: 'csv',
          data: csvWithLabels,
        };

        const { tasks: result } = parseInputData(options);

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
          title: 'Task with labels',
          labels: ['label1', 'label2'],
          assignees: ['user1', 'user2'],
        });
      });

      it('should throw MCPError for CSV missing required headers', () => {
        const options: ParseInputOptions = {
          format: 'csv',
          data: 'description,priority\nDescription 1,1',
        };

        expect(() => parseInputData(options)).toThrow(MCPError);
        expect(() => parseInputData(options)).toThrow('Missing required CSV headers: title');
      });

      it('should throw MCPError for CSV with only header row', () => {
        const options: ParseInputOptions = {
          format: 'csv',
          data: 'title,description\n',
        };

        expect(() => parseInputData(options)).toThrow(MCPError);
        expect(() => parseInputData(options)).toThrow(
          'CSV must have at least a header row and one data row',
        );
      });

      it('should throw MCPError for CSV with empty lines only', () => {
        const options: ParseInputOptions = {
          format: 'csv',
          data: '\n\n\n',
        };

        expect(() => parseInputData(options)).toThrow(MCPError);
        expect(() => parseInputData(options)).toThrow('Input data cannot be empty');
      });

      it('should handle CSV with extra whitespace', () => {
        const options: ParseInputOptions = {
          format: 'csv',
          data: '  title  ,  description  \n  Task 1  ,  Description 1  ',
        };

        const { tasks: result } = parseInputData(options);

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
          title: 'Task 1',
          description: 'Description 1',
        });
      });

      it('should parse CSV with complex fields', () => {
        const csvData = `title,description,labels,assignees,startDate,endDate,hexColor,percentDone,repeatAfter,repeatMode
"Task with, comma","Description with 'quotes'","label1;label 2","user1;user2",2023-01-01,2023-12-31,#FF0000,75,3600,1`;

        const options: ParseInputOptions = {
          format: 'csv',
          data: csvData,
        };

        const { tasks: result } = parseInputData(options);

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
          title: 'Task with, comma',
          description: "Description with 'quotes'",
          labels: ['label1', 'label 2'],
          assignees: ['user1', 'user2'],
          startDate: '2023-01-01',
          endDate: '2023-12-31',
          hexColor: '#FF0000',
          percentDone: 75,
          repeatAfter: 3600,
          repeatMode: 1,
        });
      });

      it('should handle CSV validation errors with skipErrors=true', () => {
        const csvWithInvalidData = `title,priority
Task 1,invalid_priority
Task 2,2`;

        const options: ParseInputOptions = {
          format: 'csv',
          data: csvWithInvalidData,
          skipErrors: true,
        };

        // Should not throw and should return valid tasks only
        const { tasks: result } = parseInputData(options);
        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
          title: 'Task 2',
          priority: 2,
        });
      });

      // #323: the dropped row must be recorded, not just silently missing
      // from the tasks array.
      it('should record a dropped CSV row in `skipped` with its index and error', () => {
        const csvWithInvalidData = `title,priority
Task 1,invalid_priority
Task 2,2`;

        const { tasks, skipped } = parseInputData({
          format: 'csv',
          data: csvWithInvalidData,
          skipErrors: true,
        });

        expect(tasks).toHaveLength(1);
        expect(skipped).toHaveLength(1);
        expect(skipped[0]?.index).toBe(0);
        expect(skipped[0]?.error).toContain('row 2');
      });

      it('should record every dropped CSV row when the whole batch is invalid, with correct indices', () => {
        const csvAllInvalid = `title,priority
Task 1,invalid_priority
Task 2,also_invalid`;

        const { tasks, skipped } = parseInputData({
          format: 'csv',
          data: csvAllInvalid,
          skipErrors: true,
        });

        expect(tasks).toHaveLength(0);
        expect(skipped).toHaveLength(2);
        expect(skipped.map((s) => s.index)).toEqual([0, 1]);
        expect(skipped[0]?.error).toContain('row 2');
        expect(skipped[1]?.error).toContain('row 3');
      });

      it('should return an empty `skipped` array for CSV when nothing was dropped', () => {
        const { skipped } = parseInputData({
          format: 'csv',
          data: validCsvData,
          skipErrors: true,
        });

        expect(skipped).toEqual([]);
      });

      it('should throw MCPError for CSV validation errors with skipErrors=false', () => {
        const csvWithInvalidData = `title,priority
Task 1,invalid_priority`;

        const options: ParseInputOptions = {
          format: 'csv',
          data: csvWithInvalidData,
          skipErrors: false,
        };

        expect(() => parseInputData(options)).toThrow(MCPError);
        expect(() => parseInputData(options)).toThrow('Invalid task data at row 2');
      });

      describe('RFC 4180 multiline quoted fields (issue #275)', () => {
        it('should keep an embedded newline inside a quoted field as part of that one row, not a new row', () => {
          // A quoted `description` spanning two physical lines is one CSV
          // record with two lines of text in one field — NOT two records.
          // Before the fix, splitting on '\n' before quote-aware parsing
          // tore this into a spurious extra (invalid) task.
          const csvData =
            'title,description\n' +
            '"Multi-line task","line1\nline2"\n' +
            'Second task,Normal desc';

          const options: ParseInputOptions = {
            format: 'csv',
            data: csvData,
          };

          const { tasks: result } = parseInputData(options);

          expect(result).toHaveLength(2);
          expect(result[0]).toEqual({
            title: 'Multi-line task',
            description: 'line1\nline2',
          });
          expect(result[1]).toEqual({
            title: 'Second task',
            description: 'Normal desc',
          });
        });

        it('should handle a quoted field spanning three or more physical lines', () => {
          const csvData = 'title,description\n' + '"Task A","one\ntwo\nthree"\n' + 'Task B,short';

          const { tasks: result } = parseInputData({ format: 'csv', data: csvData });

          expect(result).toHaveLength(2);
          expect(result[0]?.description).toBe('one\ntwo\nthree');
          expect(result[1]?.title).toBe('Task B');
        });

        it('should handle multiple rows each with their own multiline quoted field', () => {
          const csvData =
            'title,description\n' + '"Task A","first\nsecond"\n' + '"Task B","third\nfourth"';

          const { tasks: result } = parseInputData({ format: 'csv', data: csvData });

          expect(result).toHaveLength(2);
          expect(result[0]).toEqual({ title: 'Task A', description: 'first\nsecond' });
          expect(result[1]).toEqual({ title: 'Task B', description: 'third\nfourth' });
        });
      });
    });

    describe('Error handling and validation', () => {
      it('should throw MCPError for empty data string', () => {
        const options: ParseInputOptions = {
          format: 'json',
          data: '',
        };

        expect(() => parseInputData(options)).toThrow(MCPError);
      });

      it('should handle malformed CSV gracefully', () => {
        const malformedCsv = 'title,description\nTask1,"unclosed quote';

        const options: ParseInputOptions = {
          format: 'csv',
          data: malformedCsv,
        };

        // Should not throw, but may result in partial parsing
        expect(() => parseInputData(options)).not.toThrow();
      });

      it('should handle CSV with empty data rows', () => {
        const csvWithEmptyRows = `title,description
Task 1,Description 1

Task 3,Description 3`;

        const options: ParseInputOptions = {
          format: 'csv',
          data: csvWithEmptyRows,
        };

        const { tasks: result } = parseInputData(options);
        expect(result).toHaveLength(2); // Should skip empty row
      });
    });

    describe('Field mapping and type conversion', () => {
      it('should convert boolean fields correctly', () => {
        const csvData = `title,done,priority
Task 1,true,1
Task 2,False,2
Task 3,TRUE,3
Task 4,fAlSe,4`;

        const options: ParseInputOptions = {
          format: 'csv',
          data: csvData,
        };

        const { tasks: result } = parseInputData(options);

        expect(result).toHaveLength(4);
        expect(result[0].done).toBe(true);
        expect(result[1].done).toBe(false);
        expect(result[2].done).toBe(true);
        expect(result[3].done).toBe(false);
      });

      it('should recognize common truthy/falsy string forms for done, not just literal true/false (LOW-8)', () => {
        const csvData = `title,done
Task 1,yes
Task 2,no
Task 3,1
Task 4,0
Task 5,y
Task 6,n`;

        const { tasks: result } = parseInputData({ format: 'csv', data: csvData });

        expect(result).toHaveLength(6);
        expect(result[0].done).toBe(true);
        expect(result[1].done).toBe(false);
        expect(result[2].done).toBe(true);
        expect(result[3].done).toBe(false);
        expect(result[4].done).toBe(true);
        expect(result[5].done).toBe(false);
      });

      it('should default an unrecognized done value to false rather than silently guessing', () => {
        const csvData = `title,done
Task 1,maybe`;

        const { tasks: result } = parseInputData({ format: 'csv', data: csvData });

        expect(result).toHaveLength(1);
        expect(result[0].done).toBe(false);
      });

      it('should reject (not truncate) a non-integer decimal in a CSV numeric column (LOW-7)', () => {
        // '3.9' used to silently truncate to 3 via parseInt — a different,
        // wrong value with no error and no warning. It must now fail
        // validation instead, the same way non-numeric garbage already did.
        const csvData = `title,priority
Task 1,3.9`;

        expect(() => parseInputData({ format: 'csv', data: csvData })).toThrow(MCPError);
        expect(() => parseInputData({ format: 'csv', data: csvData })).toThrow(
          'Invalid task data at row 2',
        );
      });

      it('should skip (not truncate) a non-integer decimal numeric column when skipErrors is set', () => {
        const csvData = `title,priority
Task 1,3.9
Task 2,4`;

        const { tasks: result } = parseInputData({ format: 'csv', data: csvData, skipErrors: true });

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({ title: 'Task 2', priority: 4 });
      });

      it('should convert numeric fields correctly', () => {
        const csvData = `title,priority,percentDone,repeatAfter,repeatMode
Task 1,1,50,3600,2
Task 2,0,100,7200,0`;

        const options: ParseInputOptions = {
          format: 'csv',
          data: csvData,
        };

        const { tasks: result } = parseInputData(options);

        expect(result).toHaveLength(2);
        expect(result[0].priority).toBe(1);
        expect(result[0].percentDone).toBe(50);
        expect(result[0].repeatAfter).toBe(3600);
        expect(result[0].repeatMode).toBe(2);
        expect(result[1].priority).toBe(0);
        expect(result[1].percentDone).toBe(100);
        expect(result[1].repeatAfter).toBe(7200);
        expect(result[1].repeatMode).toBe(0);
      });

      it('should handle semicolon-separated lists correctly', () => {
        const csvData = `title,labels,assignees
Task 1,label1;label2;label3,user1;user2;user3
Task 2,single label,single user
Task 3,"label with spaces","user with spaces"`;

        const options: ParseInputOptions = {
          format: 'csv',
          data: csvData,
        };

        const { tasks: result } = parseInputData(options);

        expect(result).toHaveLength(3);
        expect(result[0].labels).toEqual(['label1', 'label2', 'label3']);
        expect(result[0].assignees).toEqual(['user1', 'user2', 'user3']);
        expect(result[1].labels).toEqual(['single label']);
        expect(result[1].assignees).toEqual(['single user']);
        expect(result[2].labels).toEqual(['label with spaces']);
        expect(result[2].assignees).toEqual(['user with spaces']);
      });
    });
  });
});
